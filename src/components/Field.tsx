export function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const { label, hint, id, ...rest } = props;
  const fid = id ?? rest.name;
  return (
    <label htmlFor={fid} className="block">
      <span className="mb-1 block text-sm font-medium text-ink-muted">{label}</span>
      <input id={fid} className="input" {...rest} />
      {hint && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}
