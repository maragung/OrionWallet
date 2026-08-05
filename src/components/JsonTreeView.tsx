import { useState } from 'react';

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
  let color = 'var(--text-primary)';
  let text: string;
  if (value === null) {
    color = 'var(--text-muted)';
    text = 'null';
  } else if (typeof value === 'string') {
    color = 'var(--success)';
    text = `"${value}"`;
  } else if (typeof value === 'number') {
    color = 'var(--accent)';
    text = String(value);
  } else if (typeof value === 'boolean') {
    color = 'var(--warning)';
    text = String(value);
  } else {
    text = String(value);
  }
  return (
    <span className="mono" style={{ color, wordBreak: 'break-all' }}>
      {text}
    </span>
  );
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

  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 'var(--sp-4)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 'var(--sp-1)',
          padding: '2px 0',
          cursor: branch ? 'pointer' : 'default',
        }}
        onClick={branch ? () => setOpen((o) => !o) : undefined}
        role={branch ? 'button' : undefined}
        tabIndex={branch ? 0 : undefined}
        onKeyDown={
          branch
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpen((o) => !o);
                }
              }
            : undefined
        }
      >
        {branch ? (
          <span
            style={{
              width: 12,
              color: 'var(--text-muted)',
              fontSize: 10,
              lineHeight: '18px',
              flexShrink: 0,
              userSelect: 'none',
            }}
          >
            {open ? '▼' : '▶'}
          </span>
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}

        {nodeKey !== null && (
          <span
            className="mono"
            style={{ color: 'var(--text-secondary)', fontWeight: 'var(--fw-semibold)' }}
          >
            {nodeKey}
            <span style={{ color: 'var(--text-muted)' }}>: </span>
          </span>
        )}

        {branch ? (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
            {typeLabel(value)}
          </span>
        ) : (
          <Primitive value={value} />
        )}
      </div>

      {branch && open && (
        <div
          style={{
            borderLeft: '1px solid var(--border-subtle)',
            marginLeft: 5,
          }}
        >
          {entries.length === 0 ? (
            <div
              style={{
                paddingLeft: 'var(--sp-4)',
                color: 'var(--text-muted)',
                fontSize: 'var(--fs-xs)',
              }}
            >
              (empty)
            </div>
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
    <div
      style={{
        fontSize: 'var(--fs-sm)',
        padding: 'var(--sp-3)',
        background: 'var(--bg-elevated-2)',
        borderRadius: 'var(--r-md)',
        overflowX: 'auto',
        maxHeight: 460,
        overflowY: 'auto',
      }}
    >
      <TreeNode nodeKey={null} value={data} depth={0} defaultOpen={defaultOpen} />
    </div>
  );
}
