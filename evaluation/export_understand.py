"""Read an existing licensed Understand database; export entities and references.
Run using Understand's upython, not the unrelated PyPI package named Understand.
No analysis database writes are performed by this script.
"""
import argparse
import json
from pathlib import Path
import understand


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('database')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    db = understand.open(args.database)
    entity_count = reference_count = 0
    errors = []
    expected_refs = []

    def ent_id(ent):
        return ent.id() if ent is not None else None

    try:
        with (output / 'entities.jsonl').open('w', encoding='utf-8') as ef, (output / 'references.jsonl').open('w', encoding='utf-8') as rf:
            for ent in db.ents():
                try:
                    record = {'id': ent.id(), 'name': ent.longname(), 'kind': ent.kind().longname(), 'unique_name': ent.uniquename(), 'parent': ent_id(ent.parent())}
                    ef.write(json.dumps(record, ensure_ascii=False) + '\n')
                    entity_count += 1
                    for ref in ent.refs():
                        target = ref.ent()
                        scope = ref.scope()
                        file = ref.file()
                        row = {'subject': ent.id(), 'kind': ref.kind().longname(), 'target': ent_id(target), 'scope': ent_id(scope), 'file': file.longname() if file is not None else None, 'line': ref.line(), 'column': ref.column(), 'forward': ref.isforward()}
                        rf.write(json.dumps(row, ensure_ascii=False) + '\n')
                        reference_count += 1
                        if target is not None and 'allow_frame' in target.longname() and file is not None and file.longname().endswith('decoder.cpp'):
                            expected_refs.append(dict(row, target_name=target.longname(), scope_name=scope.longname() if scope is not None else None))
                except Exception as ex:
                    errors.append({'entity_id': ent_id(ent), 'error_type': type(ex).__name__, 'message': str(ex)})
        summary = {'status': 'partial' if errors else 'export_completed', 'understand_version': str(understand.version()), 'entities': entity_count, 'references': reference_count, 'cross_layer_reference_evidence': expected_refs, 'errors': errors, 'note': 'Counts are not directly comparable to SCIP occurrences or CPG nodes. Export completion does not establish semantic completeness.'}
        (output / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 2 if errors else 0
    finally:
        db.close()


if __name__ == '__main__':
    raise SystemExit(main())
