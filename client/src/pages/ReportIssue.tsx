import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../api';

export function ReportIssue() {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = useMutation({
    mutationFn: () => api('/api/issues', { body: { subject, body } }),
    onSuccess: () => {
      setSent(true);
      setSubject('');
      setBody('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Something went wrong'),
  });

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="font-display text-2xl text-gold-300">Report an issue</h1>
      <p className="text-sm text-stone-400">Spotted a problem? Send a note to the admin.</p>
      {sent ? (
        <div className="card p-6 text-center">
          <p className="font-display text-xl text-gold-300">Thanks — report sent!</p>
          <button className="btn btn-ghost mt-4" onClick={() => setSent(false)}>
            Send another
          </button>
        </div>
      ) : (
        <div className="card space-y-4 p-5">
          <input className="input" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <textarea
            className="input min-h-32"
            placeholder="What happened? Include the poll or page if relevant."
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {error && <p className="text-sm text-crimson-500">{error}</p>}
          <button
            className="btn btn-gold"
            disabled={submit.isPending || !subject.trim() || !body.trim()}
            onClick={() => {
              setError(null);
              submit.mutate();
            }}
          >
            Send report
          </button>
        </div>
      )}
    </div>
  );
}
