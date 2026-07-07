import { useState } from 'react';

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!text || text === 'Unavailable') return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!text || text === 'Unavailable') return null;

  return (
    <button className="copy-btn" onClick={handleCopy} title="Copy to clipboard">
      {copied ? '✓' : '⧉'}
    </button>
  );
}
