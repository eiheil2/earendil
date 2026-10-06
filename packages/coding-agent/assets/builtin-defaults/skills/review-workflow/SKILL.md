---
name: review-workflow
description: Review a change safely, identify concrete risks, and verify the result.
---

# Review workflow

1. Read the relevant files and tests before forming a conclusion.
2. Identify behavior changes, failure paths, and missing coverage.
3. Run the narrowest relevant test command in offline mode.
4. Report findings ordered by severity with file and line references.

Use `scripts/check_review.py` to validate a review checklist before delivery.
