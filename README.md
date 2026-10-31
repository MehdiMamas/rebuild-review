# rebuild-review

A one-shot, expensive review for a project that has grown by piling on features.
It does not read a diff. It takes the project apart into what it does and what it
looks like, rebuilds the full project the best and simplest way, and scores the two.

Works on any kind of project: web, Android, iOS, Flutter, desktop, CLI, library, backend.
The pipeline is the same, and only capture and the test driver change per platform.

Platforms with a capture adapter: web (`adapters/web`) and Electron (`adapters/electron`). Setup for each is in AGENTS.md.

Status: planning. The design and the work list are in issue #1.

## What goes in

- **Words:** every feature, written as behaviour someone can check.
- **The rendered app:** what it renders on its platform, plus screenshots, network traffic
  and timings. HTML and CSS on the web, the view tree on Android, iOS and Flutter, stdout
  and files for a CLI. Never the source.
- **The technology used,** unless the review decides it should change.

## What comes out

**The full project, done the right, best way:** complete, backend included, in its own
git repo, with the same look and behaviour, built without seeing the original source.

With it come:

- **Parity:** one test suite run against both. A rebuild that lost a feature gets no score.
- **Score:** how it was done, how it's done now, what should be done, judged on
  simplicity, compatibility, speed and performance, and UX.
- **Confidence:** a percentage beside the verdict, computed by code, naming the part that limits
  it. It is the weakest of four parts: coverage (what was tested and measured out of what was
  found), agreement (do the judges agree, are their scores kept), margin (how far the result sits
  from the verdict's thresholds) and track record (how often the tool was right on known answers,
  `benchmark/calibration.json`). It is not yet a proven probability: it is only as good as the
  known-answer runs behind it, and the page says what they covered.
