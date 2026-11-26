import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, cityName, inr, type SearchItem, type Together } from '../api';
import { useCart, useToast } from '../state';
import { track } from '../track';
import { ProductImage } from './ProductImage';

/** Picks that go with these products (GET /together): ClickHouse co-purchases, then complements. */
export function useTogether(ids: number[], city: string | null, size = 4): Together | null {
  const key = ids.join(',');
  const [data, setData] = useState<Together | null>(null);
  useEffect(() => {
    setData(null);
    if (!city || !key) return;
    const ctrl = new AbortController();
    api<Together>(`/together?city=${city}&ids=${key}&size=${size}`, {}, ctrl.signal).then(setData, () => {});
    return () => ctrl.abort();
  }, [key, city, size]);
  return data;
}

/**
 * Product page: "Frequently bought together". This product plus up to three picks, each with a tick;
 * one button adds every ticked one to the cart. Picks from real orders say so.
 */
export function BoughtTogether({ product, city, data }: {
  product: Pick<SearchItem, 'productId' | 'name' | 'pricePaise' | 'imageKey' | 'sku'>;
  city: string;
  data: Together | null;
}) {
  const { add } = useCart();
  const { toast } = useToast();
  const picks = useMemo(() => (data?.items ?? []).slice(0, 3), [data]);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => setOff(new Set()), [product.productId]);
  if (!picks.length) return null;

  const fromOrders = picks.some((p) => p.basis === 'orders');
  const chosen = picks.filter((p) => !off.has(p.productId));
  const total = product.pricePaise + chosen.reduce((n, p) => n + p.pricePaise, 0);
  const toggle = (id: number) => setOff((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const addAll = async () => {
    setBusy(true);
    let added = 0;
    try {
      for (const id of [product.productId, ...chosen.map((p) => p.productId)]) if (await add(id, 1)) added++;
      track('click', { label: 'together-add', productId: product.productId, results: chosen.length });
      if (added) toast(`Added ${added} ${added === 1 ? 'item' : 'items'} to your cart`, { label: 'View cart', to: '/cart' });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="together box" aria-label="Frequently bought together">
      <div className="together-head">
        <h3 className="similar-title">{fromOrders ? 'Frequently bought together' : `Goes well with it, in stock in ${cityName(city)}`}</h3>
        <span className="muted small">
          {picks.every((p) => p.basis === 'orders') ? 'From what shoppers ordered together' : fromOrders ? 'From real orders, plus picks for the same uses' : 'Picked for the same uses'}
        </span>
      </div>
      <div className="together-row">
        <div className="together-item is-main">
          <span className="together-art"><ProductImage imageKey={product.imageKey} productId={product.productId} sku={product.sku} name={product.name} /></span>
          <span className="together-name">This item: {product.name}</span>
          <b>{inr(product.pricePaise)}</b>
        </div>
        {picks.map((p) => (
          <label key={p.productId} className={`together-item ${off.has(p.productId) ? 'is-off' : ''}`}>
            <span className="together-plus" aria-hidden="true">+</span>
            <input type="checkbox" checked={!off.has(p.productId)} onChange={() => toggle(p.productId)} />
            <span className="together-art"><ProductImage imageKey={p.imageKey} productId={p.productId} sku={p.sku} name={p.name} /></span>
            <Link to={`/p/${p.productId}`} className="together-name" data-track="together-open" data-product={p.productId}>{p.name}</Link>
            <span><b>{inr(p.pricePaise)}</b> <span className="muted small">· {p.qty} left</span></span>
          </label>
        ))}
      </div>
      <div className="together-foot">
        <span>Total for {chosen.length + 1}: <b className="price">{inr(total)}</b></span>
        <button className="btn btn-primary" onClick={addAll} disabled={busy}>
          {busy ? 'Adding…' : chosen.length ? `Add all ${chosen.length + 1} to cart` : 'Add this item to cart'}
        </button>
      </div>
    </section>
  );
}

/** Cart page: "Goes well with your cart". One tap adds. */
export function CartAddOns({ ids, city }: { ids: number[]; city: string }) {
  const { add } = useCart();
  const { toast } = useToast();
  const data = useTogether(ids, city, 4);
  const [busy, setBusy] = useState<number | null>(null);
  const items = (data?.items ?? []).filter((i) => !ids.includes(i.productId));
  if (!items.length) return null;

  const onAdd = async (i: SearchItem) => {
    setBusy(i.productId);
    try {
      if (await add(i.productId, 1)) {
        track('click', { label: 'cart-addon-add', productId: i.productId });
        toast(`Added ${i.name}`);
      }
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="similar addons" aria-label="Goes well with your cart">
      <h3 className="similar-title">{items.some((i) => i.basis === 'orders') ? 'Often bought with what’s in your cart' : 'Goes well with your cart'}</h3>
      <ul className="similar-list">
        {items.map((i) => (
          <li key={i.productId}>
            <div className="similar-card">
              <Link to={`/p/${i.productId}`} className="similar-art"><ProductImage imageKey={i.imageKey} productId={i.productId} sku={i.sku} name={i.name} /></Link>
              <Link to={`/p/${i.productId}`} className="similar-name">{i.name}</Link>
              <span className="similar-meta"><b>{inr(i.pricePaise)}</b> · {i.qty} left</span>
              <button className="btn btn-small addon-btn" onClick={() => onAdd(i)} disabled={busy === i.productId}>
                {busy === i.productId ? 'Adding…' : '+ Add'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
