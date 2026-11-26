import { useEffect, useState } from 'react';
import { api, inr, type Offer } from '../api';

/**
 * "Same item from other sellers near you": partner retailers in the shopper's city that have this
 * product. Shown wherever our own shelf can't serve the shopper, so they can still buy on StockHop.
 */
export function PartnerOffers({ productId, city, title, ourPricePaise, busySellerId, onBuy, emptyText }: {
  productId: number;
  city: string;
  title: string;
  /** To show how a partner's price compares with ours. */
  ourPricePaise?: number;
  busySellerId?: number | null;
  onBuy: (offer: Offer) => void;
  /** Shown when no partner has it; omit to render nothing. */
  emptyText?: string;
}) {
  const [offers, setOffers] = useState<Offer[] | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setOffers(null);
    api<{ items: Offer[] }>(`/offers?productId=${productId}&city=${city}`, {}, ctrl.signal).then((r) => setOffers(r.items), () => setOffers([]));
    return () => ctrl.abort();
  }, [productId, city]);

  if (offers === null) return <div className="offers is-loading" aria-busy="true"><div className="sk-line skeleton" style={{ width: '50%' }} /></div>;
  if (offers.length === 0) return emptyText ? <p className="offers-empty muted">{emptyText}</p> : null;

  return (
    <section className="offers" aria-label={title}>
      <h3 className="offers-title">{title}</h3>
      <ul className="offers-list">
        {offers.map((o) => {
          const diff = ourPricePaise ? o.pricePaise - ourPricePaise : 0;
          return (
            <li key={o.sellerId} className="offer">
              <div className="offer-who">
                <b>{o.sellerName}</b>
                <span className="offer-meta">
                  <span aria-label={`rated ${o.rating} out of 5`}>★ {o.rating.toFixed(1)}</span>
                  <span>{o.deliveryNote}</span>
                </span>
              </div>
              <div className="offer-buy">
                <span className="offer-price">
                  {inr(o.pricePaise)}
                  {diff !== 0 && <small className={diff < 0 ? 'cheaper' : ''}>{diff < 0 ? `${inr(-diff)} less` : `${inr(diff)} more`}</small>}
                </span>
                <span className={o.qty <= 2 ? 'offer-qty low' : 'offer-qty'}>{o.qty} left</span>
                <button type="button" className="btn btn-sm btn-primary" data-track="rescue-partner" onClick={() => onBuy(o)} disabled={busySellerId != null}>
                  {busySellerId === o.sellerId ? 'Reserving…' : `Buy from ${o.sellerName}`}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="offers-note muted small">Partner shops in your city. Their stock is reserved the moment you press Buy, just like ours, and you pay on StockHop.</p>
    </section>
  );
}
