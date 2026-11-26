import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, cityName, inr, type SearchItem } from '../api';
import { ProductImage } from './ProductImage';

/**
 * "Similar, in stock in <city>" (doc/19): OpenSearch more_like_this on this product's document,
 * only items actually on the shelf in the shopper's city. Another way out of a sold-out page.
 */
export function Similar({ productId, city, title, compact = false, onPick }: {
  productId: number;
  city: string;
  title?: string;
  compact?: boolean;
  onPick?: () => void;
}) {
  const [items, setItems] = useState<SearchItem[] | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    setItems(null);
    api<{ items: SearchItem[] }>(`/products/${productId}/similar?city=${city}`, {}, ctrl.signal).then((r) => setItems(r.items), () => setItems([]));
    return () => ctrl.abort();
  }, [productId, city]);

  if (!items || items.length === 0) return null;
  const shown = compact ? items.slice(0, 3) : items;
  return (
    <section className={compact ? 'similar compact' : 'similar'} aria-label={title ?? `Similar, in stock in ${cityName(city)}`}>
      <h3 className="similar-title">{title ?? `Similar, in stock in ${cityName(city)} now`}</h3>
      <ul className="similar-list">
        {shown.map((i) => (
          <li key={i.productId}>
            <Link to={`/p/${i.productId}`} className="similar-card" onClick={onPick}>
              <span className="similar-art"><ProductImage imageKey={i.imageKey} productId={i.productId} sku={i.sku} name={i.name} /></span>
              <span className="similar-name">{i.name}</span>
              <span className="similar-meta"><b>{inr(i.pricePaise)}</b> · {i.qty} left</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
