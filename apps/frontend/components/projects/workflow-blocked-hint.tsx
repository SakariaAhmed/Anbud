/**
 * Explains why a generate button is disabled while the project already has a
 * job or unfinished document processing. Pair with aria-describedby={id}.
 */
export function WorkflowBlockedHint({
  id,
  reason,
}: {
  id: string;
  reason: string | null | undefined;
}) {
  if (!reason) return null;
  return (
    <p id={id} className="text-sm leading-6 text-slate-600">
      {reason}
    </p>
  );
}
