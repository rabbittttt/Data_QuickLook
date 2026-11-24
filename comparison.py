"""Cross-source comparisons: aggregate independently, align without row joins."""
import json
import re

import pandas as pd
from analysis_engine import numbers


def aggregate(frame, dimension, metric, operation):
    data = pd.DataFrame({'对比项': frame[dimension], '数值': numbers(frame[metric])})
    data = data.dropna(subset=['对比项'])
    data['对比项'] = data['对比项'].astype(str).str.strip()
    grouped = data.groupby('对比项', sort=False)['数值']
    if operation == '求和':
        result = grouped.sum(min_count=1)
    elif operation == '有效数值计数':
        result = grouped.count()
    else:
        result = grouped.agg({'平均值': 'mean', '最大值': 'max', '最小值': 'min'}[operation])
    return result


def field_registry(catalog):
    fields = {}
    for row in catalog.itertuples():
        for field in json.loads(row.columns_json):
            key = (row.id, field['name'])
            fields[key] = f"{field['name']} · {row.table_name} / {row.sheet_name} / {row.file_name} [{row.range_ref}; {row.id[:6]}]"
    return fields


def render_comparison(store, catalog):
    import plotly.express as px
    import streamlit as st

    st.subheader('跨表对比')
    st.caption('从所有已识别表格中搜索任意字段；每组单独指定维度和筛选，再按维度值对齐。来源不同的指标不会自动相加。')
    registry = field_registry(catalog)
    search = st.text_input('搜索字段、车型、表名或文件名', key='compare_search')
    available = [key for key, label in registry.items() if all(word.lower() in label.lower() for word in search.split())]
    # The stored selection is kept in the options while searching other sources.
    selected_before = st.session_state.get('compare_fields', [])
    available = list(dict.fromkeys([k for k in selected_before if k in registry] + available))
    default = next((key for key in available if any(w in key[1] for w in ('销量', '订单量', '交付量'))), None)
    selected = st.multiselect('对比参数（可跨文件、多选）', available, default=[default] if default else [],
                             format_func=registry.get, key='compare_fields')
    if not selected:
        st.info('选择一个或多个参数，即可生成推荐图表和对比表。')
        return
    series = []
    temporal = []
    for index, (dataset_id, metric) in enumerate(selected):
        frame = store.load(dataset_id)
        columns = [c for c in frame.columns if not c.startswith('_')]
        token = f'{dataset_id}:{metric}'
        with st.expander(f'{index + 1}. {registry[(dataset_id, metric)]}', expanded=len(selected) <= 2):
            mode = st.radio('数据布局', ['按字段分组', '横向月份/日期列'], key=token+'layout', horizontal=True)
            filters = st.multiselect('筛选字段', columns, key=token+'filters')
            for column in filters:
                values = sorted(frame[column].dropna().astype(str).unique())
                chosen = st.multiselect(column, values, key=token+'filter:'+column)
                if chosen:
                    frame = frame[frame[column].astype(str).isin(chosen)]
            ops = ['求和', '平均值', '最大值', '最小值', '有效数值计数']
            rate = any(w in metric for w in ('率', '占比', '比例', '%'))
            operation = st.selectbox('聚合方式', ops, index=1 if rate else 0, key=token+'op')
            if rate:
                st.caption('比例默认展示算术平均；业务总体比例需用对应分子和分母重新计算。')
            if mode == '横向月份/日期列':
                defaults = [c for c in columns if re.search(r'^(\d{4}[-年/])?\d{1,2}(月|[-/]\d{1,2}|$)', c)]
                periods = st.multiselect('选择需要对比的时间列', columns, default=defaults, key=token+'periods')
                if not periods:
                    continue
                work = frame[periods].melt(var_name='期间', value_name='指标值')
                dimension = '期间'
                result = aggregate(work, dimension, '指标值', operation)
                temporal.append(True)
            else:
                preferred = next((c for c in columns if any(w in c for w in ('月份', '日期', '车型', '版本', '区域'))), columns[0])
                dimension = st.selectbox('对齐维度（各表可选不同字段名）', columns, index=columns.index(preferred), key=token+'dim')
                result = aggregate(frame, dimension, metric, operation)
                temporal.append(any(w in dimension for w in ('日期', '时间', '月份', '年月')))
            label = st.text_input('系列名称', value=f'{index+1}. {metric} · {catalog.loc[catalog.id == dataset_id, "table_name"].iloc[0]}', key=token+'label')
            result.name = f'{index+1} | {label}'
            series.append(result)
    if not series:
        return
    aligned = pd.concat(series, axis=1)
    if aligned.empty:
        st.info('筛选后没有数据。')
        return
    st.caption('缺失项保留为空；只有维度值相同才会对齐。不同单位建议选择“分面图”。')
    chart = st.selectbox('图表展示', ['推荐默认', '分组柱状图', '折线图', '横向排名图', '分面图', '仅表格'])
    recommended = '折线图' if all(temporal) else '分组柱状图' if len(series) > 1 else '横向排名图'
    chart = recommended if chart == '推荐默认' else chart
    st.caption(f'推荐：{recommended}。' + ('时间维度按时间顺序展示。' if all(temporal) else '并排显示各来源数值，便于比较。'))
    if all(temporal):
        def period_key(value):
            return tuple(int(v) for v in re.findall(r'\d+', str(value)))
        aligned = aligned.loc[sorted(aligned.index, key=period_key)]
    limit = st.number_input('图表最多显示项数（完整数据见下表）', 1, 500, 20)
    shown = aligned.tail(int(limit)) if all(temporal) else aligned.sort_values(aligned.columns[0], ascending=False).head(int(limit))
    long = shown.rename_axis('对比项').reset_index().melt(id_vars='对比项', var_name='系列', value_name='数值')
    if chart != '仅表格':
        if chart == '折线图':
            fig = px.line(long, x='对比项', y='数值', color='系列', markers=True)
            fig.update_traces(connectgaps=False)
        elif chart == '横向排名图':
            fig = px.bar(long, y='对比项', x='数值', color='系列', barmode='group', orientation='h')
        elif chart == '分面图':
            fig = px.bar(long, x='对比项', y='数值', facet_row='系列', color='系列')
            fig.update_yaxes(matches=None)
        else:
            fig = px.bar(long, x='对比项', y='数值', color='系列', barmode='group')
        fig.update_layout(template='plotly_white', height=max(460, len(series)*220) if chart == '分面图' else 500)
        st.plotly_chart(fig, width='stretch', key='comparison_chart')
    if len(series) >= 2 and st.checkbox('计算相对基准的差值与变化率（确认指标单位、口径相同）'):
        baseline = st.selectbox('基准系列', aligned.columns)
        base = aligned[baseline]
        for col in list(aligned.columns):
            if col != baseline:
                aligned[col+' 差值'] = aligned[col] - base
                aligned[col+' 变化率(%)'] = (aligned[col] - base).div(base.where(base.ne(0))) * 100
    st.dataframe(aligned, width='stretch')
    st.download_button('下载完整对比 CSV', aligned.to_csv().encode('utf-8-sig'), 'comparison.csv', 'text/csv')
