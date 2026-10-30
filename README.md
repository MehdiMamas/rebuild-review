# rebuild-review

A one-shot, expensive review for a project that has grown by piling on features.
It does not read a diff. It writes down what the project does, rebuilds it from that
description and its rendered output, without seeing the source, and scores the two.

Status: planning. The design and the work list are in issue #1.

## What it does

1. **Words:** every feature, written as behaviour someone can check.
2. **Output:** the rendered HTML and CSS, screenshots, network traffic and timings of
   the running app. Never the React (or other) source.
3. **Rebuild:** the simplest version with the same output and behaviour, built with no
   access to the source.
4. **Parity:** one test suite run against both. A rebuild that lost a feature gets no score.
5. **Score:** how it was done, how the rebuild did it, what should be done, judged on
   simplicity, compatibility, speed and performance, and UX.
