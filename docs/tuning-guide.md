# Deduplication Tuning Guide

This guide explains the scoring constants in `js/dedup-utils.js`.

## Core Parameters

| Parameter | Default | Effect |
| --- | ---: | --- |
| `seamBandFraction` | `0.50` | Candidate boxes must be near the shared edge between adjacent sides. |
| `sizeRatioMin` | `0.30` | Rejects pairs with very different bbox area. |
| `vertTol` | `0.22` | Controls how far vertical centroids may drift. |
| `autoMin` | `0.72` | Minimum score for automatic suggestions. |
| `candidateMin` | `0.58` | Minimum score for weaker manual-review candidates. |

## Signals

- `seam`: how close both boxes are to the shared edge.
- `vert`: vertical centroid agreement.
- `size`: area and aspect-ratio agreement.
- `cls`: class-distance multiplier.

Class is a multiplier, not a hard gate. A likely pair with adjacent class labels can still be suggested, but the score is reduced.

## Common Adjustments

If too many wrong pairs are suggested:

- Increase `autoMin`.
- Decrease `seamBandFraction`.
- Decrease `vertTol`.
- Increase `sizeRatioMin`.

If obvious duplicate bunches are missing:

- Decrease `autoMin`.
- Increase `candidateMin` only if the review panel becomes too noisy.
- Increase `seamBandFraction`.
- Lower `sizeRatioMin` when camera distance changes between sides.

If dense trees over-link:

- Prefer stricter `autoMin` and `vertTol`.
- Review the side order first; wrong side order creates impossible adjacency.

## Validation Workflow

Use a small validation set with known unique-bunch counts and known cross-side links.

1. Load the validation trees.
2. Run suggestions.
3. Track false links, missed links, and final unique-bunch count error.
4. Change one parameter at a time.
5. Re-run suggestions on the same trees.

## Capture Assumptions

- Side order follows physical rotation around the tree.
- Camera distance is roughly consistent.
- Adjacent views overlap near the tree edge.
- Initial YOLO labels are already close enough for human correction.
