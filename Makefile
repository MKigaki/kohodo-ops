DATE ?= $(shell date +%F)
PYTHONPATH := .

.PHONY: run pull normalize reconcile

run: pull normalize reconcile

pull:
	PYTHONPATH=$(PYTHONPATH) python jobs/pull_all_sources.py --date $(DATE)

normalize:
	PYTHONPATH=$(PYTHONPATH) python jobs/normalize.py --date $(DATE)

reconcile:
	PYTHONPATH=$(PYTHONPATH) python jobs/reconcile_report.py --date $(DATE)
