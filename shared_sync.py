"""Observe shared workbooks before publishing stable versions to the warehouse."""

import time

from warehouse import file_signature, scan_source_files


SCAN_INTERVAL = 5 * 60
STABLE_INTERVAL = 60


class SharedFileMonitor:
    def __init__(self, roots, versions, clock=time.monotonic):
        self.roots = roots
        self.versions = versions
        self.clock = clock
        self.next_scan = 0
        self.pending = {}
        self.errors = []

    def check(self):
        now = self.clock()
        if now >= self.next_scan:
            self.next_scan = now + SCAN_INTERVAL
            paths, self.errors = scan_source_files(self.roots())
            versions = self.versions()
            # An inaccessible or removed source must not be treated as stable.
            visible = set(paths)
            self.pending = {path: state for path, state in self.pending.items() if path in visible}
            for path in paths:
                try:
                    signature = file_signature(path)
                    if versions.get(str(path)) == signature:
                        self.pending.pop(path, None)
                    elif path not in self.pending or self.pending[path][0] != signature:
                        self.pending[path] = (signature, self.clock())
                except OSError as exc:
                    self.errors.append(f'{path.name}: {exc}')
                    self.pending.pop(path, None)

        ready = {}
        for path, (signature, observed_at) in list(self.pending.items()):
            if self.clock() - observed_at < STABLE_INTERVAL:
                continue
            try:
                current = file_signature(path)
                if current == signature:
                    ready[path] = signature
                    del self.pending[path]
                else:
                    self.pending[path] = (current, self.clock())
            except OSError as exc:
                self.errors.append(f'{path.name}: {exc}')
                del self.pending[path]
        deadline = min([self.next_scan, *[observed + STABLE_INTERVAL for _, observed in self.pending.values()]])
        return ready, max(0.05, deadline - self.clock())
