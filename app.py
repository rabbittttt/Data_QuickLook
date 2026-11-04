from __future__ import annotations

from pathlib import Path
import json

import pandas as pd
import plotly.express as px
import streamlit as st

from analysis_engine import apply_filters, dimension_candidates, interpret_question, numeric_candidates, summarize
from warehouse import Warehouse
from comparison import render_comparison
from source_paths import source_config


ROOT = Path(__file__).resolve().parent
SOURCE_SETTINGS = source_config(ROOT)
DEFAULT_SOURCES = SOURCE_SETTINGS.get('folders', [SOURCE_SETTINGS['folder']])
DATABASE = ROOT / "output_file" / "warehouse.db"

st.set_page_config(page_title="经营数据查询助手", page_icon=":material/bar_chart:", layout="wide")

st.markdown(
    """
    <style>
    :root { --primary:#1E40AF; --secondary:#3B82F6; --accent:#D97706; --surface:#FFFFFF; --muted:#F1F5F9; }
    .stApp { background: #F8FAFC; color: #0F172A; }
    [data-testid="stSidebar"] { background:#FFFFFF; border-right:1px solid #DBEAFE; }
    h1,h2,h3 { color:#1E3A8A; letter-spacing:-0.02em; }
    div[data-testid="stMetric"] { background:#FFFFFF; border:1px solid #DBEAFE; border-radius:12px; padding:14px 16px; }
    div[data-testid="stMetricValue"] { color:#1E40AF; }
    .stButton > button { min-height:44px; border-radius:9px; font-weight:600; }
    .stButton > button[kind="primary"] { background:#1E40AF; color:#FFFFFF; }
    div[data-testid="stDataFrame"] { border:1px solid #DBEAFE; border-radius:10px; overflow:hidden; }
    .dataset-note { color:#475569; font-size:.9rem; padding:.5rem 0 1rem; }
    @media (max-width: 768px) { .block-container { padding:1rem; } }
    @media (prefers-reduced-motion: reduce) { * { animation:none!important; transition:none!important; } }
    </style>
    """,
    unsafe_allow_html=True,
)


@st.cache_resource
def warehouse() -> Warehouse:
    return Warehouse(DATABASE)


def choose_dataset(catalog: pd.DataFrame, key: str) -> str:
    labels = {
        row.id: f"{row.table_name} · {row.file_name} / {row.sheet_name} ({row.row_count:,} 行)"
        for row in catalog.itertuples()
    }
    return st.selectbox("数据表", labels.keys(), format_func=labels.get, key=key)


def render_chart(data: pd.DataFrame, dimension: str, metric: str, chart_type: str):
    if chart_type == "折线图":
        figure = px.line(data, x=dimension, y=metric, markers=True)
    elif chart_type == "饼图":
        figure = px.pie(data, names=dimension, values=metric, hole=0.42)
    else:
        figure = px.bar(data, x=dimension, y=metric)
    figure.update_layout(
        template="plotly_white", colorway=["#1E40AF", "#3B82F6", "#D97706", "#0F766E"],
        margin=dict(l=20, r=20, t=30, b=20), height=460,
    )
    st.plotly_chart(figure, width="stretch")


store = warehouse()
with st.sidebar:
    st.subheader("数据源")
    source_text = st.text_area("Excel 数据源（每行一个目录）", value='\n'.join(DEFAULT_SOURCES), help="同时扫描多个目录及其子目录中的 .xlsx 和 .xlsm；相对路径按本项目目录解析")
    folders = [str((ROOT / Path(p.strip()).expanduser()).resolve()) for p in source_text.splitlines() if p.strip()]
    st.caption('递归读取新增及变更文件；读取失败保留上次数据。移走的文件仍保留历史数据。')
    if st.button("同步新增和变更文件", type="primary", width="stretch"):
        with st.spinner("正在识别 Excel 中的数据表…"):
            try:
                result = store.sync(folders)
                st.success(f"已识别 {result.files} 个文件、{result.tables} 张表、{result.rows:,} 行数据")
                if result.errors:
                    st.warning("部分文件未能读取：\n" + "\n".join(result.errors))
            except Exception as exc:
                st.error(str(exc))
    auto_sync = st.checkbox('每 60 秒检查新增和变更文件', value=False)

if auto_sync:
    @st.fragment(run_every=60)
    def refresh_sources():
        try:
            before = store.catalog().to_json()
            result = store.sync(folders)
            if result.errors:
                st.warning('同步未完成：' + '\n'.join(result.errors))
            if before != store.catalog().to_json():
                st.rerun()
            st.caption('自动同步已开启（页面保持打开时有效）')
        except Exception as exc:
            st.error(f'自动同步失败：{exc}')
    refresh_sources()

st.title("经营数据查询助手")
st.caption("集中识别分散 Excel，快速完成查询、筛选和经营分析")

catalog = store.catalog()
if catalog.empty:
    st.info("请在左侧确认 Excel 文件夹，然后点击“扫描并重建数据目录”。")
    st.stop()

metric_cols = st.columns(4)
metric_cols[0].metric("数据表", f"{len(catalog):,}")
metric_cols[1].metric("数据行", f"{int(catalog.row_count.sum()):,}")
metric_cols[2].metric("Excel 文件", f"{catalog.file_name.nunique():,}")
metric_cols[3].metric("字段", f"{int(catalog.column_count.sum()):,}")

comparison_tab, catalog_tab, analysis_tab, question_tab = st.tabs(["跨表对比", "数据目录", "单表分析", "自然语言查询"])

with comparison_tab:
    render_comparison(store, catalog)

with catalog_tab:
    st.subheader("已识别数据表")
    display = catalog[["table_name", "file_name", "sheet_name", "range_ref", "row_count", "column_count"]].rename(
        columns={"table_name":"表名", "file_name":"文件", "sheet_name":"Sheet", "range_ref":"区域", "row_count":"行数", "column_count":"字段数"}
    )
    st.dataframe(display, width="stretch", hide_index=True)
    selected = choose_dataset(catalog, "preview_dataset")
    preview = store.load(selected)
    fields = json.loads(catalog.loc[catalog.id == selected, "columns_json"].iloc[0])
    st.text('字段：' + '、'.join(item['name'] for item in fields))
    st.dataframe(preview.head(200), width="stretch", hide_index=True)

with analysis_tab:
    selected = choose_dataset(catalog, "analysis_dataset")
    frame = store.load(selected)
    dimensions = dimension_candidates(frame)
    metrics = numeric_candidates(frame)
    if not dimensions or not metrics:
        st.warning("当前数据表缺少可用的维度或数值指标。")
    else:
        control_a, control_b, control_c, control_d = st.columns(4)
        dimension = control_a.selectbox("分析维度", dimensions)
        metric = control_b.selectbox("分析指标", metrics)
        aggregation = control_c.selectbox("聚合方式", ["求和", "平均值", "计数", "最大值", "最小值"])
        chart_type = control_d.selectbox("图表类型", ["柱状图", "折线图", "饼图"])
        filters = {}
        with st.expander("筛选条件", expanded=True):
            filter_columns = st.multiselect("选择筛选字段", dimensions, max_selections=6)
            for column in filter_columns:
                options = sorted(frame[column].dropna().astype(str).unique().tolist())
                filters[column] = st.multiselect(column, options)
        filtered = apply_filters(frame, filters)
        result = summarize(filtered, dimension, metric, aggregation)
        if result.empty:
            st.info("当前筛选条件下没有可分析的数据。")
        else:
            max_items = min(100, len(result))
            top_n = st.slider("显示前 N 项", 1, max_items, min(20, max_items)) if max_items > 1 else 1
            result = result.head(top_n)
            chart_col, table_col = st.columns([1.6, 1])
            with chart_col:
                render_chart(result, dimension, metric, chart_type)
            with table_col:
                st.dataframe(result, width="stretch", hide_index=True, height=460)
            st.download_button("下载当前分析 CSV", result.to_csv(index=False).encode("utf-8-sig"), "analysis.csv", "text/csv")

with question_tab:
    selected = choose_dataset(catalog, "question_dataset")
    frame = store.load(selected)
    question = st.text_input("输入问题", placeholder="例如：按车型看销量，筛选问界 M8")
    if question:
        intent = interpret_question(question, frame)
        if not intent["metric"] or not intent["dimension"]:
            st.warning("没有识别到可聚合的指标和维度，请换一种说法或使用“自助分析”。")
        else:
            filtered = apply_filters(frame, intent["filters"])
            result = summarize(filtered, intent["dimension"], intent["metric"], "求和")
            st.caption(f"已识别：维度「{intent['dimension']}」；指标「{intent['metric']}」；筛选 {intent['filters'] or '无'}")
            render_chart(result.head(30), intent["dimension"], intent["metric"], "柱状图")
            st.dataframe(result, width="stretch", hide_index=True)
