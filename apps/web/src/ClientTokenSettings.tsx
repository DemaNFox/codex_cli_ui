import { useEffect, useState, type FormEvent } from 'react';

import { api, type ClientToken } from './api.js';

export function ClientTokenSettings({ csrfToken }: { csrfToken: string }) {
  const [tokens, setTokens] = useState<ClientToken[]>([]);
  const [name, setName] = useState('');
  const [days, setDays] = useState(30);
  const [allowCancel, setAllowCancel] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api.clientTokens().then(
      (value) => {
        if (live) setTokens(value);
      },
      (cause: unknown) => {
        if (live) setError(String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      const result = await api.createClientToken(csrfToken, {
        name: name.trim(),
        scopes: allowCancel ? ['submit', 'read', 'cancel'] : ['submit', 'read'],
        expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
      });
      setIssued(result.token);
      setTokens((current) => [
        {
          id: result.id,
          name: result.name,
          scopes: result.scopes,
          createdAt: result.createdAt,
          expiresAt: result.expiresAt,
          revokedAt: result.revokedAt,
        },
        ...current,
      ]);
      setName('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.revokeClientToken(csrfToken, id);
      setTokens((current) =>
        current.map((token) =>
          token.id === id ? { ...token, revokedAt: new Date().toISOString() } : token,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h3>Внешние клиенты</h3>
      <p>
        Ключ позволяет отправлять задачи в этот серверный Codex. Сохраните его в системном хранилище
        секретов клиента: повторно он не показывается.
      </p>
      <form onSubmit={(event) => void create(event)}>
        <label htmlFor="client-token-name">Имя устройства</label>
        <input
          id="client-token-name"
          value={name}
          maxLength={80}
          required
          onChange={(event) => setName(event.target.value)}
        />
        <label htmlFor="client-token-days">Срок действия, дней</label>
        <input
          id="client-token-days"
          type="number"
          min={1}
          max={365}
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
        />
        <label>
          <input
            type="checkbox"
            checked={allowCancel}
            onChange={(event) => setAllowCancel(event.target.checked)}
          />{' '}
          Разрешить отмену задач
        </label>
        <button type="submit" disabled={busy || !name.trim() || days < 1 || days > 365}>
          Выпустить ключ
        </button>
      </form>
      {issued && (
        <div role="status">
          <p>Скопируйте ключ сейчас. После закрытия этой вкладки он исчезнет.</p>
          <code style={{ overflowWrap: 'anywhere' }}>{issued}</code>
          <button type="button" onClick={() => void navigator.clipboard.writeText(issued)}>
            Копировать
          </button>
          <button type="button" onClick={() => setIssued(null)}>
            Скрыть
          </button>
        </div>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <ul className="skill-list settings-skill-list">
        {tokens.map((token) => (
          <li key={token.id}>
            <span>
              <strong>{token.name}</strong>
              <small>
                {token.scopes.join(', ')} · до{' '}
                {new Date(token.expiresAt).toLocaleDateString('ru-RU')}
                {token.revokedAt ? ' · отозван' : ''}
              </small>
            </span>
            {!token.revokedAt && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void revoke(token.id)}
              >
                Отозвать
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
