import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, cityName, post, type CityCode } from '../api';
import { EVENTS, trackConversion } from '../experiments';

/**
 * Reviews: the "reviews" version of the product_trust_signal experiment (doc/experiment.md).
 * ReviewSummary sits under the price; ReviewsSection lists reviews and takes new ones.
 * Both are rendered only for shoppers in that version, so control never loads them.
 */

export type Reviews = {
  average: number | null;
  count: number;
  breakdown: [number, number, number, number, number];
  reviews: { id: number; rating: number; body: string; authorName: string; city: string | null; createdAt: string }[];
  yours: boolean;
};

export function useReviews(productId: number | null, enabled: boolean) {
  const [data, setData] = useState<Reviews | null>(null);
  useEffect(() => {
    setData(null);
    if (!enabled || productId === null) return;
    const ctl = new AbortController();
    api<Reviews>(`/products/${productId}/reviews`, {}, ctl.signal).then(setData, () => {});
    return () => ctl.abort();
  }, [productId, enabled]);
  return [data, setData] as const;
}

export function Stars({ value, size = 16 }: { value: number; size?: number }) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <span className="stars" style={{ fontSize: size }} role="img" aria-label={`${value.toFixed(1)} out of 5 stars`}>
      <span className="stars-bg" aria-hidden="true">★★★★★</span>
      <span className="stars-fg" aria-hidden="true" style={{ width: `${pct}%` }}>★★★★★</span>
    </span>
  );
}

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
};

/** Under the price: average, count and the best recent review, linking down to the full list. */
export function ReviewSummary({ data }: { data: Reviews | null }) {
  if (!data) return <p className="review-summary is-loading" aria-hidden="true" />;
  if (data.count === 0 || data.average === null) {
    return (
      <p className="review-summary">
        <a href="#reviews" className="link-btn">No reviews yet. Be the first to review it</a>
      </p>
    );
  }
  const quote = data.reviews.find((r) => r.rating >= 4) ?? data.reviews[0];
  return (
    <div className="review-summary">
      <a href="#reviews" className="review-score" data-track="review-summary">
        <Stars value={data.average} />
        <b>{data.average.toFixed(1)}</b>
        <span className="review-count">{data.count} {data.count === 1 ? 'review' : 'reviews'}</span>
      </a>
      {quote && (
        <blockquote className="review-quote">
          “{quote.body}”
          <cite>{quote.authorName}{quote.city ? `, ${cityName(quote.city as CityCode)}` : ''}</cite>
        </blockquote>
      )}
    </div>
  );
}

/** Below the product details: rating breakdown, latest reviews and the form to add one. */
export function ReviewsSection({ productId, city, data, onChange }: {
  productId: number;
  city: string;
  data: Reviews | null;
  onChange: (r: Reviews) => void;
}) {
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!rating) {
      setMsg({ ok: false, text: 'Pick a star rating.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      onChange(await post<Reviews>(`/products/${productId}/reviews`, { rating, body, name, city }));
      trackConversion(EVENTS.reviewSubmitted, rating);
      setMsg({ ok: true, text: 'Thanks! Your review is up.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Couldn’t post your review. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="reviews pdp-block" id="reviews" aria-label="Reviews">
      <h2 className="pdp-h">Reviews</h2>
      {data && data.count > 0 && data.average !== null && (
        <div className="reviews-head">
          <div className="reviews-score">
            <b>{data.average.toFixed(1)}</b>
            <Stars value={data.average} size={20} />
            <span className="muted small">{data.count} {data.count === 1 ? 'review' : 'reviews'}</span>
          </div>
          <ul className="reviews-bars" aria-label="Rating breakdown">
            {data.breakdown.map((n, i) => (
              <li key={i}>
                <span>{5 - i}★</span>
                <span className="bar"><span style={{ width: `${data.count ? (n / data.count) * 100 : 0}%` }} /></span>
                <span className="muted small">{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data && data.reviews.length > 0 && (
        <ul className="review-list">
          {data.reviews.map((r) => (
            <li key={r.id} className="review">
              <div className="review-meta">
                <Stars value={r.rating} size={14} />
                <b>{r.authorName}</b>
                <span className="muted small">{r.city ? `${cityName(r.city as CityCode)} · ` : ''}{ago(r.createdAt)}</span>
              </div>
              <p>{r.body}</p>
            </li>
          ))}
        </ul>
      )}

      {data?.yours ? (
        <p className="notice">You’ve reviewed this product. Thank you!</p>
      ) : (
        <form className="box form review-form" onSubmit={submit}>
          <h3 className="review-form-title">Write a review</h3>
          <fieldset className="star-input" aria-label="Your rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className={n <= rating ? 'on' : ''} aria-pressed={n === rating}
                aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setRating(n)}>★</button>
            ))}
          </fieldset>
          <label>
            Your review
            <textarea required minLength={10} maxLength={500} rows={3} value={body} data-no-track
              placeholder="What did you like, and what could be better?" onChange={(e) => setBody(e.target.value)} />
          </label>
          <label>
            Name to show
            <input required maxLength={40} value={name} autoComplete="given-name" onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Posting…' : 'Post review'}</button>
          {msg && <p className={`small ${msg.ok ? 'ok-text' : 'error-text'}`} role="status">{msg.text}</p>}
        </form>
      )}
    </section>
  );
}
