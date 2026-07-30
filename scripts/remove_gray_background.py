#!/usr/bin/env python3
"""Remove an edge-connected gray background and encode transparent VP9 WebM."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import cv2
import numpy as np


def build_alpha(
    frame: np.ndarray,
    *,
    min_gray: int,
    max_gray: int,
    max_chroma: int,
    min_component: int,
    remove_lower_holes: bool,
    remove_flat_holes: bool = False,
) -> np.ndarray:
    channels = frame.astype(np.int16)
    lightness = channels.mean(axis=2)
    chroma = channels.max(axis=2) - channels.min(axis=2)

    gray_background = (
        (lightness >= min_gray)
        & (lightness <= max_gray)
        & (chroma <= max_chroma)
    ).astype(np.uint8)
    gray_background = cv2.morphologyEx(
        gray_background,
        cv2.MORPH_OPEN,
        np.ones((3, 3), dtype=np.uint8),
    )

    label_count, labels = cv2.connectedComponents(gray_background, connectivity=8)
    if label_count <= 1:
        return np.full(frame.shape[:2], 255, dtype=np.uint8)

    border_labels = np.unique(
        np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1]))
    )
    border_labels = border_labels[border_labels != 0]
    background = np.isin(labels, border_labels)

    if remove_lower_holes:
        frame_height, frame_width = frame.shape[:2]
        border_label_set = set(border_labels.tolist())
        for label in range(1, label_count):
            if label in border_label_set:
                continue
            ys, xs = np.where(labels == label)
            if len(xs) < min_component:
                continue
            if (
                float(xs.mean()) < frame_width * 0.46
                and float(ys.mean()) > frame_height * 0.58
            ):
                background[labels == label] = True

    if remove_flat_holes:
        border_label_set = set(border_labels.tolist())
        for label in range(1, label_count):
            if label in border_label_set:
                continue
            component = labels == label
            area = int(component.sum())
            if area < max(1000, min_component * 4):
                continue
            # The source animation has nearly uniform gray regions enclosed by
            # the character, pickaxe, and rocks. Real shaded artwork has much
            # more variation, so this removes those trapped background holes.
            component_pixels = frame[component]
            component_mean = float(component_pixels.mean())
            if 145.0 <= component_mean <= 175.0 and float(component_pixels.std()) <= 8.0:
                background[component] = True

    foreground = (~background).astype(np.uint8)

    component_count, component_labels, stats, _ = cv2.connectedComponentsWithStats(
        foreground,
        connectivity=8,
    )
    clean_foreground = np.zeros_like(foreground)
    for label in range(1, component_count):
        if stats[label, cv2.CC_STAT_AREA] >= min_component:
            clean_foreground[component_labels == label] = 1

    alpha = clean_foreground * 255
    return cv2.GaussianBlur(alpha, (3, 3), 0.65)


def video_metadata(path: Path) -> tuple[float, int, int, int]:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open video: {path}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 24.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    capture.release()
    return fps, width, height, frames


def find_crop(path: Path, args: argparse.Namespace) -> tuple[int, int, int, int]:
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS) or 24.0
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, round(args.start * fps)))
    min_x = min_y = None
    max_x = max_y = None

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        alpha = build_alpha(
            frame,
            min_gray=args.min_gray,
            max_gray=args.max_gray,
            max_chroma=args.max_chroma,
            min_component=args.min_component,
            remove_lower_holes=args.remove_lower_holes,
            remove_flat_holes=args.remove_flat_holes,
        )
        points = cv2.findNonZero((alpha >= 32).astype(np.uint8))
        if points is None:
            continue
        x, y, width, height = cv2.boundingRect(points)
        min_x = x if min_x is None else min(min_x, x)
        min_y = y if min_y is None else min(min_y, y)
        max_x = x + width if max_x is None else max(max_x, x + width)
        max_y = y + height if max_y is None else max(max_y, y + height)

    capture.release()
    if min_x is None:
        raise RuntimeError(f"No foreground detected in {path}")

    _, source_width, source_height, _ = video_metadata(path)
    x1 = max(0, min_x - args.padding)
    y1 = max(0, min_y - args.padding)
    x2 = min(source_width, max_x + args.padding)
    y2 = min(source_height, max_y + args.padding)

    if (x2 - x1) % 2:
        x2 = min(source_width, x2 + 1)
    if (y2 - y1) % 2:
        y2 = min(source_height, y2 + 1)
    return x1, y1, x2, y2


def encode(path: Path, output: Path, ffmpeg: Path, args: argparse.Namespace) -> None:
    fps, _, _, frame_count = video_metadata(path)
    start_frame = max(0, min(frame_count, round(args.start * fps)))
    remaining_frames = frame_count - start_frame
    x1, y1, x2, y2 = find_crop(path, args)
    width = x2 - x1
    height = y2 - y1
    output.parent.mkdir(parents=True, exist_ok=True)

    command = [
        str(ffmpeg),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        f"{width}x{height}",
        "-framerate",
        f"{fps:.6f}",
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-row-mt",
        "1",
        "-deadline",
        "good",
        "-cpu-used",
        "2",
        "-crf",
        str(args.crf),
        "-b:v",
        "0",
        "-metadata:s:v:0",
        "alpha_mode=1",
        str(output),
    ]

    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    capture = cv2.VideoCapture(str(path))
    capture.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    written = 0
    first_rgba = None
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            alpha = build_alpha(
                frame,
                min_gray=args.min_gray,
                max_gray=args.max_gray,
                max_chroma=args.max_chroma,
                min_component=args.min_component,
                remove_lower_holes=args.remove_lower_holes,
                remove_flat_holes=args.remove_flat_holes,
            )
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            rgba = np.dstack((rgb, alpha))[y1:y2, x1:x2]
            if first_rgba is None:
                first_rgba = rgba.copy()
            elif args.close_loop and written == remaining_frames - 1:
                rgba = first_rgba
            process.stdin.write(rgba.tobytes())
            written += 1
    finally:
        capture.release()
        if process.stdin:
            process.stdin.close()

    return_code = process.wait()
    if return_code:
        raise RuntimeError(f"FFmpeg exited with code {return_code}")
    print(
        f"{path.name}: {written}/{remaining_frames} frames, "
        f"start {args.start:.2f}s, "
        f"{width}x{height}, {fps:.2f} FPS -> {output}"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--min-gray", type=int, default=125)
    parser.add_argument("--max-gray", type=int, default=195)
    parser.add_argument("--max-chroma", type=int, default=24)
    parser.add_argument("--min-component", type=int, default=80)
    parser.add_argument("--padding", type=int, default=20)
    parser.add_argument("--crf", type=int, default=24)
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--close-loop", action="store_true")
    parser.add_argument("--remove-lower-holes", action="store_true")
    parser.add_argument("--remove-flat-holes", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    cli_args = parse_args()
    encode(cli_args.input, cli_args.output, cli_args.ffmpeg, cli_args)
