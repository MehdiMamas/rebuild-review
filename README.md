# rebuild-review

A one-shot, expensive review for a project that has grown by piling on features.
It does not read a diff. It takes the project apart into what it does and what it
looks like, rebuilds the full project the best and simplest way, and scores the two.

Status: planning. The design and the work list are in issue #1.

## What goes in

- **Words:** every feature, written as behaviour someone can check.
- **The rendered app:** the HTML and CSS it renders in a browser, screenshots, network
  traffic and timings. Never the React (or other) source.
- **The technology used,** unless the review decides it should change.

## What comes out

**The full project, done the right, best way:** complete, backend included, in its own
git repo, with the same look and behaviour, built without seeing the original source.

With it come:

- **Parity:** one test suite run against both. A rebuild that lost a feature gets no score.
- **Score:** how it was done, how it's done now, what should be done, judged on
  simplicity, compatibility, speed and performance, and UX.
