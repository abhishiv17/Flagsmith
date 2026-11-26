import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { cityName, type SearchItem } from '../api';
import { useCity } from '../state';
import { useLiveStock } from '../hooks';
import { useSaved } from '../lists';
import { CardSkeleton, ProductCard } from '../components/ui';
import { RecentlyViewed } from '../components/RecentlyViewed';

/**
 * Saved items (wishlist), kept in this browser. Each card shows live stock in the shopper's city,
 * so a saved item that just came back (or is down to its last one) is obvious.
 */
export function Saved() {
  const { city } = useCity();
  const { items } = useSaved();
  // Snapshot → card; stock starts unknown (version 0) so the live poll's answer always wins.
  const cards: SearchItem[] = useMemo(
    () => items.map((i) => ({
      productId: i.productId, sku: i.sku, name: i.name, brand: i.brand, category: i.category, pricePaise: i.pricePaise,
      imageKey: i.imageKey, city: city ?? 'BLR', qty: 0, inStock: true, stockVersion: 0, nearby: null,
    })),
    [items, city],
  );
  const live = useLiveStock(city, useMemo(() => cards.slice(0, 48).map((c) => c.productId), [cards]));
  const here = city ? cityName(city) : 'your city';
  const inStock = cards.filter((c) => live.get(c.productId)?.inStock).length;

  return (
    <main className="shell page">
      <header className="shop-head">
        <div>
          <h1 className="page-title">Saved items</h1>
          <p className="muted">
            {items.length
              ? `${items.length} saved · ${live.size ? `${inStock} in stock in ${here} right now` : `checking stock in ${here}…`}`
              : 'Tap the heart on any product to keep it here.'}
          </p>
        </div>
      </header>
      {items.length === 0 ? (
        <div className="empty-state">
          <h2>Nothing saved yet</h2>
          <p className="muted">Saved items stay in this browser, with live stock in your city every time you come back.</p>
          <Link className="btn btn-primary" to="/shop">Start shopping</Link>
        </div>
      ) : (
        <div className="grid">
          {/* Until the first live answer, placeholders: the snapshot has no stock to show. */}
          {live.size === 0
            ? cards.map((c) => <CardSkeleton key={c.productId} />)
            : cards.map((c) => <ProductCard key={c.productId} item={c} live={live.get(c.productId)} />)}
        </div>
      )}
      <RecentlyViewed />
    </main>
  );
}
