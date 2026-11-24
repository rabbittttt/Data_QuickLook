"""Exercise a built release with a disposable data root and capture comparable UI components."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

from openpyxl import Workbook
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright, expect


def request(base, route, body=None, content_type='application/json'):
    headers = {'Content-Type': content_type} if body is not None else {}
    with urlopen(Request(base + route, data=body, headers=headers), timeout=10) as response:
        return response.read(), response.status, response.headers.get_content_type()


@contextmanager
def service(payload, root):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = dict(os.environ, DATA_QUICKLOOK_DATA_DIR=str(root/'state'),
               SHARED_DATA_ROOT=str(root/'shared'), DATA_QUICKLOOK_PUBLIC_PREFIX='/quicklook/',
               DATA_QUICKLOOK_PUBLIC_ORIGIN='')
    process = subprocess.Popen([sys.executable, '-B', 'server.py', '--port', str(port)], cwd=payload, env=env)
    base = f'http://127.0.0.1:{port}/quicklook/'
    try:
        for _ in range(120):
            if process.poll() is not None:
                raise RuntimeError('Service exited during startup')
            try:
                request(base, 'healthz')
                break
            except URLError:
                time.sleep(0.25)
        else:
            raise RuntimeError("Service health check timed out")
        yield base
    finally:
        process.terminate()
        process.wait(timeout=15)


def seed(base, root):
    book = Workbook()
    sheet = book.active
    sheet.title = '销量'
    sheet.append(['车型', '累计销量'])
    for value in (100, 200, 300, 400, 500):
        sheet.append(['M8', value])
    fixture = root/'sales.xlsx'
    book.save(fixture)
    request(base, 'api/import?filename=sales.xlsx', fixture.read_bytes(), 'application/octet-stream')
    request(base, 'api/sync', b'{}')
    for _ in range(120):
        catalog = json.loads(request(base, 'api/catalog')[0])
        if not catalog['status']['busy'] and catalog['tables']:
            break
        time.sleep(0.25)
    else:
        raise RuntimeError('Fixture did not finish importing')
    rows = json.loads(request(base, 'api/table?id=' + catalog['tables'][0]['id'])[0])['rows']
    assert [row['累计销量'] for row in rows] == [100, 200, 300, 400, 500]


def check_monthly_layouts(browser, base, root):
    months = ['2026年1月', '2026年2月', '2026年3月']
    book = Workbook()
    records = book.active
    records.title = '纵排'
    records.append(['月份', '销量'])
    for month, value in zip(months, (100, 120, 140)):
        records.append([month, value])
    for count in (2, 3):
        sheet = book.create_sheet(f'横排{count}')
        sheet.append(['车型', '版本', *months[:count]])
        sheet.append(['M8', 'Pro', *[100, 120, 140][:count]])
        sheet.append([None, 'Max', *[70, 80, 90][:count]])
        sheet.merge_cells('A2:A3')
    path = root/'monthly.xlsx'
    book.save(path)
    request(base, 'api/import?filename=monthly.xlsx', path.read_bytes(), 'application/octet-stream')
    request(base, 'api/sync', b'{}')
    for _ in range(120):
        catalog = json.loads(request(base, 'api/catalog')[0])
        tables = [t for t in catalog['tables'] if t['file_name'] == path.name]
        if not catalog['status']['busy'] and len(tables) == 3:
            break
        time.sleep(0.25)
    else:
        raise RuntimeError('Monthly fixtures were not indexed')
    page = browser.new_page()
    page.goto(base)
    results = {}
    for table in tables:
        data = json.loads(request(base, 'api/table?id=' + table['id'])[0])
        if table['sheet_name'].startswith('横排'):
            assert [(r['车型'], r['版本']) for r in data['rows']] == [('M8', 'Pro'), ('M8', 'Max')]
        results[table['sheet_name']] = page.evaluate(
            '([t,d]) => Array.from(aggregateRows(d,overviewSeries(t,d.rows)))', [table, data])
    page.close()
    expected = [[f'2026-0{i}', v] for i, v in enumerate((100, 120, 140), 1)]
    assert results == {'纵排': expected, '横排2': expected[:2], '横排3': expected}, results


def capture(browser, base, output, check_values):
    for width in (1440, 390):
        page = browser.new_page(viewport={'width': width, 'height': 900}, reduced_motion='reduce')
        page.goto(base)
        page.locator('.mini-chart canvas').first.wait_for()
        page.locator('.overview-cards .card').first.screenshot(path=output/f'{width}-card.png')
        for route in ('home', 'explore', 'compare', 'saved'):
            page.locator(f'#nav [data-page="{route}"]').click()
            expect(page.locator(f'#nav [data-page="{route}"]')).to_have_attribute('aria-current', 'page')
            if width == 390:
                page.locator('#menuToggle').click()
            expect(page.locator('#importButton')).to_be_visible()
            expect(page.get_by_role('button', name='同步数据', exact=True)).to_be_visible()
            page.locator('#nav').screenshot(path=output/f'{width}-{route}-nav.png')
            if width == 390:
                page.locator('#sidebarClose').click()
        if check_values and width == 1440:
            page.locator('#nav [data-page="home"]').click()
            page.locator('[data-recommend]').first.click()
            page.locator('#studioShow').click()
            page.locator('#studioNew').click()
            page.locator('#studioAppend').click()
            manager = page.locator('.applied-series-manager')
            manager.locator('summary').click()
            manager.locator('[data-edit-uid]').nth(1).click()
            label = page.locator('#studioLabel')
            label.evaluate("el=>{for(let d=el.closest('details');d;d=d.parentElement.closest('details'))d.open=true}")
            label.fill('复核第二组')
            label.press('Tab')
            page.locator('#studioUpdate').click()
            page.reload()
            expect(page.locator('[data-edit-uid]').nth(1)).to_contain_text('复核第二组')
            page.wait_for_function("""() => {
                const instance=echarts.getInstanceByDom(document.querySelector('#compareChart'));
                const series=instance?.getOption()?.series;
                return series?.length===2 && series.every(s=>s.data.length===1 && s.data[0]===500);
            }""")
        page.close()


def differences(reference, output):
    changed = []
    for path in sorted(output.glob('*.png')):
        with Image.open(path) as candidate, Image.open(reference/path.name) as baseline:
            size = tuple(map(max, zip(candidate.size, baseline.size)))
            canvases = []
            for image in (candidate, baseline):
                canvas = Image.new('RGB', size, 'white')
                canvas.paste(image.convert('RGB'))
                canvases.append(canvas)
            diff = ImageChops.difference(*canvases)
            if candidate.size != baseline.size or diff.getbbox():
                diff.save(output/('diff-'+path.name))
                changed.append(path.name)
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--capture-only', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    project = args.project.resolve()
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=project, text=True).strip()
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        release = root/'release'
        subprocess.run([sys.executable, '-B', str(project/'scripts/build_release.py'), '--destination',
                        str(release), '--version', 'verify-'+revision[:12]], check=True)
        manifest = json.loads((release/'app-release.json').read_text(encoding='utf-8'))
        payload = release/'payload'
        summary = {'commit': revision, 'version': manifest['version'], 'payload': manifest['sourceRevision']}
        with service(payload, root) as base:
            seed(base, root)
            for route in ('healthz', 'api/catalog', 'favicon.svg'):
                start = time.monotonic()
                content, status, kind = request(base, route)
                summary[route] = {'status': status, 'type': kind, 'ms': round(1000*(time.monotonic()-start))}
                if route == 'favicon.svg':
                    digest = hashlib.sha256(content).hexdigest()
                    assert digest == next(f['sha256'] for f in manifest['files'] if f['path']=='web/favicon.svg')
                    summary[route]['sha256'] = digest
                else:
                    assert kind == 'application/json'
                    json.loads(content)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=os.environ.get('QUICKLOOK_TEST_BROWSER'))
                capture(browser, base, args.output, not args.capture_only)
                if not args.capture_only:
                    check_monthly_layouts(browser, base, root)
                browser.close()
        if args.baseline:
            summary['changedScreenshots'] = differences(args.baseline, args.output)
        (args.output/'results.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
        print(summary)


if __name__ == '__main__':
    main()
