"""本番実験前のリハーサル用ダミーデータ生成。

V-Mate実験_運営マニュアルと発信文言_2026-06-19.md の §4-2 セッション後アンケート
(6項目)と、V-Mate_身体様式比較_研究実装計画_2026-06-18.md の仮説 H1-H4 に沿って、
3条件(text/stylized/realistic)それぞれに条件差を持たせたダミー回答を生成する。
あくまで分析パイプラインの動作確認用で、実データではない。
"""

from __future__ import annotations

import csv
from pathlib import Path

import numpy as np

CONDITIONS = ("text", "stylized", "realistic")
N_PER_CONDITION = 12
METRICS = (
    "social_presence",
    "trust",
    "self_disclosure",
    "continuance_intention",
    "usability",
    "creepiness",
)

# H1: stylized > text (social_presence)
# H2: stylized < realistic (creepiness)
# H3: stylized >= realistic (self_disclosure, continuance_intention)
# H4: text > stylized/realistic (usability)
CONDITION_MEANS: dict[str, dict[str, float]] = {
    "text": {
        "social_presence": 2.4,
        "trust": 3.2,
        "self_disclosure": 3.0,
        "continuance_intention": 2.8,
        "usability": 4.3,
        "creepiness": 1.5,
    },
    "stylized": {
        "social_presence": 3.8,
        "trust": 3.7,
        "self_disclosure": 3.9,
        "continuance_intention": 3.9,
        "usability": 3.6,
        "creepiness": 1.8,
    },
    "realistic": {
        "social_presence": 3.9,
        "trust": 3.3,
        "self_disclosure": 3.2,
        "continuance_intention": 3.1,
        "usability": 3.2,
        "creepiness": 3.4,
    },
}

MANIPULATION_CHECK_ACCURACY = 0.85
OUTPUT_PATH = Path(__file__).parent / "dummy_research_events.csv"


def _clip_scale(value: float, lo: int = 1, hi: int = 5) -> int:
    return int(np.clip(round(value), lo, hi))


def generate(seed: int = 42) -> list[dict[str, object]]:
    rng = np.random.default_rng(seed)
    rows: list[dict[str, object]] = []
    participant_index = 1

    for condition in CONDITIONS:
        means = CONDITION_MEANS[condition]
        for _ in range(N_PER_CONDITION):
            participant_id = f"P{participant_index:03d}"
            participant_index += 1

            row: dict[str, object] = {
                "participant_id": participant_id,
                "condition": condition,
            }
            for metric in METRICS:
                noisy_value = rng.normal(loc=means[metric], scale=0.8)
                row[metric] = _clip_scale(noisy_value)

            correctly_perceived = rng.random() < MANIPULATION_CHECK_ACCURACY
            row["manipulation_check"] = (
                condition if correctly_perceived else rng.choice(CONDITIONS)
            )
            rows.append(row)

    return rows


def write_csv(rows: list[dict[str, object]], path: Path = OUTPUT_PATH) -> None:
    fieldnames = ["participant_id", "condition", *METRICS, "manipulation_check"]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    rows = generate()
    write_csv(rows)
    print(f"{len(rows)}件のダミーデータを書き出した: {OUTPUT_PATH}")
