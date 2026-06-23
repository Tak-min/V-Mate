"""V-Mate実験 分析パイプラインのリハーサル実行スクリプト。

V-Mate実験_運営マニュアルと発信文言_2026-06-19.md §6 の手順
(記述統計 → マニピュレーションチェック → Kruskal-Wallis → 事後検定)を、
本番実験前にダミーデータで一度通すためのもの。本番では同じ手順を
research_events からCSV化した実データに対して実行する想定。
"""

from __future__ import annotations

import itertools
from pathlib import Path

import pandas as pd
from scipy import stats

from generate_dummy_data import METRICS, OUTPUT_PATH, generate, write_csv

ALPHA = 0.05


def load(path: Path = OUTPUT_PATH) -> pd.DataFrame:
    if not path.exists():
        write_csv(generate())
    return pd.read_csv(path)


def describe(df: pd.DataFrame) -> pd.DataFrame:
    return df.groupby("condition")[list(METRICS)].agg(["mean", "median", "std"])


def manipulation_check_accuracy(df: pd.DataFrame) -> pd.Series:
    correct = df["condition"] == df["manipulation_check"]
    return correct.groupby(df["condition"]).mean()


def kruskal_wallis(df: pd.DataFrame) -> dict[str, tuple[float, float]]:
    results: dict[str, tuple[float, float]] = {}
    for metric in METRICS:
        groups = [g[metric].to_numpy() for _, g in df.groupby("condition")]
        statistic, p_value = stats.kruskal(*groups)
        results[metric] = (statistic, p_value)
    return results


def pairwise_mannwhitney_bonferroni(
    df: pd.DataFrame, metric: str
) -> dict[tuple[str, str], float]:
    conditions = sorted(df["condition"].unique())
    pairs = list(itertools.combinations(conditions, 2))
    raw_p = {}
    for a, b in pairs:
        sample_a = df.loc[df["condition"] == a, metric]
        sample_b = df.loc[df["condition"] == b, metric]
        _, p_value = stats.mannwhitneyu(sample_a, sample_b, alternative="two-sided")
        raw_p[(a, b)] = p_value
    correction_factor = len(pairs)
    return {pair: min(p * correction_factor, 1.0) for pair, p in raw_p.items()}


def run_report(df: pd.DataFrame) -> None:
    print("=== 1. 記述統計(条件ごとの平均・中央値・標準偏差) ===")
    print(describe(df))
    print()

    print("=== 2. マニピュレーションチェック(条件正答率) ===")
    print(manipulation_check_accuracy(df))
    print()

    print("=== 3. Kruskal-Wallis検定(全体差) ===")
    kw_results = kruskal_wallis(df)
    for metric, (statistic, p_value) in kw_results.items():
        flag = "*" if p_value < ALPHA else ""
        print(f"  {metric}: H={statistic:.3f}, p={p_value:.4f} {flag}")
    print()

    significant_metrics = [m for m, (_, p) in kw_results.items() if p < ALPHA]
    print(f"=== 4. 事後検定(Mann-Whitney, Bonferroni補正) 有意だった指標: {significant_metrics or 'なし'} ===")
    for metric in significant_metrics:
        adjusted = pairwise_mannwhitney_bonferroni(df, metric)
        print(f"  [{metric}]")
        for (a, b), p_value in adjusted.items():
            flag = "*" if p_value < ALPHA else ""
            print(f"    {a} vs {b}: p_adj={p_value:.4f} {flag}")
    print()


if __name__ == "__main__":
    run_report(load())
