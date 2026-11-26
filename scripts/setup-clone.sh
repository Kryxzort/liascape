#!/usr/bin/env bash
# One-time setup of a clone: the commit-message hook and the merge driver for docs/TODO.md and docs/decisions.md
# (`scripts/merge-docs.py`, named in .gitattributes). Safe to run again.
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath scripts/git-hooks
git config merge.liascape-docs.name "Liascape TODO / decisions block merge"
git config merge.liascape-docs.driver 'python3 scripts/merge-docs.py %O %A %B'
echo "setup-clone: hooks and the docs merge driver are set"
