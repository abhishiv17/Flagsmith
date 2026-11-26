import { Link } from 'react-router-dom';
import { inr } from '../api';
import { clearViewed, useViewed } from '../lists';
import { ProductImage } from './ProductImage';

/** "Recently viewed": the last products this browser opened (lists.ts), newest first. */
export function RecentlyViewed({ exclude, title = 'Recently viewed', max = 8 }: { exclude?: number; title?: string; max?: number }) {
  const items = useViewed().filter((i) => i.productId !== exclude).slice(0, max);
  if (!items.length) return null;
  return (
    <section className="similar recent-strip" aria-label={title}>
      <div className="recent-head">
        <h3 className="similar-title">{title}</h3>
        <button type="button" className="link-btn small" onClick={clearViewed}>Clear</button>
      </div>
      <ul className="similar-list">
        {items.map((i) => (
          <li key={i.productId}>
            <Link to={`/p/${i.productId}`} className="similar-card">
              <span className="similar-art"><ProductImage imageKey={i.imageKey} productId={i.productId} sku={i.sku} name={i.name} /></span>
              <span className="similar-name">{i.name}</span>
              <span className="similar-meta"><b>{inr(i.pricePaise)}</b> · {i.brand}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
