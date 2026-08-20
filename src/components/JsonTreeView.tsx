import { useState } from 'react';
import { Icon } from './icons/Icon';

/**
 * Collapsible JSON tree view. Objects and arrays render as expandable nodes;
 * primitives render inline. Used by the Contract Viewer to make Program Info
 * and Storage explorable instead of a flat blob.
 */

type Json = unknown;

function typeLabel(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `Array[${v.length}]`;
  if (typeof v === 'object') return `Object{${Object.keys(v as object).length}}`;
  return typeof v;
}

function isBranch(v: Json): boolean {
  return v !== null && typeof v === 'object';
}

function Primitive({ value }: { value: Json }) {
  let kind = 'other';
  let text: string;
  if (value === null) {
    kind = 'null';
    text = 'null';
  } else if (typeof value === 'string') {
    kind = 'str';
    text = `"${value}"`;
  } else if (typeof value === 'number') {
    kind = 'num';
    text = String(value);
  } else if (typeof value === 'boolean') {
    kind = 'bool';
    text = String(value);
  } else {
    text = String(value);
  }
  return <span className={`mono json-val ${kind}`}>{text}</span>;
}

function TreeNode({
  nodeKey,
  value,
  depth,
  defaultOpen,
}: {
  nodeKey: string | number | null;
  value: Json;
  depth: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const branch = isBranch(value);
  const entries: Array<[string | number, Json]> = branch
    ? Array.isArray(value)
      ? (value as Json[]).map((v, i) => [i, v])
      : Object.entries(value as Record<string, Json>)
    : [];

  const label = (
    <>
      <span className="json-caret">
        {branch && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />}
      </span>

      {nodeKey !== null && (
        <span className="mono json-key">
          {nodeKey}
          <span className="json-punct">: </span>
        </span>
      )}

      {branch ? <span className="json-type">{typeLabel(value)}</span> : <Primitive value={value} />}
    </>
  );

  return (
    <div className="json-node">
      {/* A branch row is a real button, so Enter and Space toggle it without a
          hand-written key handler; a leaf is not focusable because there is
          nothing to activate. */}
      {branch ? (
        <button
          type="button"
          className="json-row"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {label}
        </button>
      ) : (
        <div className="json-row">{label}</div>
      )}

      {branch && open && (
        <div className="json-children">
          {entries.length === 0 ? (
            <div className="json-empty">(empty)</div>
          ) : (
            entries.map(([k, v]) => (
              <TreeNode
                key={String(k)}
                nodeKey={k}
                value={v}
                depth={depth + 1}
                defaultOpen={depth < 1}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function JsonTreeView({ data, defaultOpen = true }: { data: Json; defaultOpen?: boolean }) {
  return (
    <div className="json-tree">
      <TreeNode nodeKey={null} value={data} depth={0} defaultOpen={defaultOpen} />
    </div>
  );
}
