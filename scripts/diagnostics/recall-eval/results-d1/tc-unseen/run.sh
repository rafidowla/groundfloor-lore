#!/bin/bash
# usage: run.sh <engine sqlite|surreal-lance> <cachesub sqlite|sl> <cfg off|on|tc>
export PATH=$(ls -d ~/.nvm/versions/node/v22*/bin | tail -1):$PATH
# F = dir holding logs-e1/cache (fixture cache) and the worktree; L = this dir's copies of the u-*.json inputs
L=${L:-$F/logs-e1v}
W=${W:-$F/e1-term-coverage}
ENG=$1; SUB=$2; CFG=$3
C=$L/cache-$SUB-$CFG
rm -rf $C; mkdir -p $C; cp -R $L/../logs-e1/cache/$SUB/. $C/
case $CFG in off) A="--abstain off";; on) A="--abstain on --term-coverage off";; tc) A="--abstain on --term-coverage on";; esac
cd $W
perl -e 'alarm shift; exec @ARGV' 2400 node scripts/diagnostics/recall-eval/runner.mjs --engine $ENG --embedder real --code-rows 10000 --depth 0 --search-mode hybrid \
  --cache-root $C --questions-file $L/u-questions.json --distractors-file $L/u-distractors.json \
  --identifiers-file $L/u-idp.json --absent-identifiers-file $L/u-ida.json --skip-negatives $A \
  --out $L/res-$ENG-$CFG.json > $L/log-$ENG-$CFG.txt 2>&1
echo "rc=$? $ENG $CFG" >> $L/rcs.txt
