#!/usr/bin/env bun
import { backfillExistingFiles } from "../services/pools";

const r = await backfillExistingFiles();
console.log(`Backfill done: scanned ${r.filesScanned} files, updated ${r.filesUpdated}`);
console.log(` pooled: added=${r.pooled.added} dup=${r.pooled.skippedDuplicate} invalid=${r.pooled.skippedInvalid} ineligible=${r.pooled.skippedIneligible} taken=${r.pooled.skippedTaken} filtered=${r.pooled.skippedFiltered}`);
process.exit(0);
