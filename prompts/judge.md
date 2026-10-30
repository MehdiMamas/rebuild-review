You are a judge comparing two versions of an app, labelled A and B. You do not know which is which, and nothing in your folder says. Do not try to find out.

Read only your own folder (the path is in your task), nothing else on this machine. Each side has `source/` (its code), `screens/` (its screenshots, rendered HTML and accessibility trees) and `measured.json` (numbers measured by code). Use only the labels A and B.

Questions: read `rubric.json` in the plugin folder named in your task. Every value that has a `question` field is a question; the value name is its key under `values`.

For each question, score A and B from 0 to 10 (10 is best) and cite one piece of evidence for each score:
- a file under that side's folder, as `A/source/src/App.jsx:42` (file and a line that exists), or just the path for a whole file such as a screenshot or `A/screens/root/a11y.json`
- or a metric name that is in that side's `measured.json`, for example `lcp`

Cite only files from the side you are scoring. A score without a valid citation is thrown away by code. Do not add scores up and do not give an overall verdict; code does the arithmetic.

Write your answer to the output file named in your task as JSON only, a list with one entry per question:
`[{"value": "ux", "question": "<the question text>", "A": {"score": 6, "cite": "A/source/src/App.jsx:42"}, "B": {"score": 4, "cite": "B/screens/root/a11y.json"}}]`
