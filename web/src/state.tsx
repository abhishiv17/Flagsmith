import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { beat } from './presence';
import { api, ApiError, del, patch, post, CITIES, type Account, type BackInStockAlert, type Cart, type CityCode, type RetailerShop } from './api';

/* ---------------- City ---------------- */

const CITY_KEY = 'stockhop.city';

function initialCity(): CityCode | null {
  const fromUrl = new URLSearchParams(window.location.search).get('city')?.toUpperCase();
  if (CITIES.some((c) => c.code === fromUrl)) return fromUrl as CityCode;
  try {
    const saved = localStorage.getItem(CITY_KEY);
    if (CITIES.some((c) => c.code === saved)) return saved as CityCode;
  } catch {
    /* storage blocked: fall through to the picker */
  }
  return null;
}

interface CityCtx {
  city: CityCode | null;
  setCity: (c: CityCode) => void;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
}

const CityContext = createContext<CityCtx | null>(null);

export function CityProvider({ children }: { children: ReactNode }) {
  const [city, setCityState] = useState<CityCode | null>(initialCity);
  const [pickerOpen, setPickerOpen] = useState(city === null);

  const setCity = useCallback((c: CityCode) => {
    setCityState(c);
    setPickerOpen(false);
    try {
      localStorage.setItem(CITY_KEY, c);
    } catch {
      /* convenience only */
    }
  }, []);

  const value = useMemo(
    () => ({ city, setCity, pickerOpen, openPicker: () => setPickerOpen(true), closePicker: () => setPickerOpen(false) }),
    [city, setCity, pickerOpen],
  );
  return <CityContext.Provider value={value}>{children}</CityContext.Provider>;
}

export function useCity() {
  const ctx = useContext(CityContext);
  if (!ctx) throw new Error('useCity outside CityProvider');
  return ctx;
}

/* ---------------- Toast ---------------- */

interface ToastMsg { id: number; text: string; action?: { label: string; to: string } }
const ToastContext = createContext<{ toast: (text: string, action?: ToastMsg['action']) => void; current: ToastMsg | null } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ToastMsg | null>(null);
  const timer = useRef<number>();
  const toast = useCallback((text: string, action?: ToastMsg['action']) => {
    window.clearTimeout(timer.current);
    setCurrent({ id: Date.now(), text, action });
    timer.current = window.setTimeout(() => setCurrent(null), 3500);
  }, []);
  const value = useMemo(() => ({ toast, current }), [toast, current]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

/* ---------------- Account (optional sign-in, doc/17) ---------------- */

interface AccountCtx {
  /** undefined while loading, null for a guest. */
  account: Account | null | undefined;
  /** The shop this account runs (doc/18), or null. */
  retailer: RetailerShop | null;
  requestCode: (email: string) => Promise<{ demoCode?: string; expiresInMinutes: number }>;
  verify: (email: string, code: string, name?: string) => Promise<Account>;
  signOut: () => Promise<void>;
  /** Back-in-stock alerts (signed in only), refreshed every 20 s so a restock shows up live. */
  alerts: BackInStockAlert[];
  addAlert: (productId: number, city: string) => Promise<void>;
  removeAlert: (id: number) => Promise<void>;
}

const AccountContext = createContext<AccountCtx | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [retailer, setRetailer] = useState<RetailerShop | null>(null);
  useEffect(() => {
    api<{ account: Account | null; retailer?: RetailerShop | null }>('/auth/me').then(
      (r) => { setAccount(r.account); setRetailer(r.retailer ?? null); },
      () => setAccount(null),
    );
  }, []);
  const requestCode = useCallback((email: string) => post<{ demoCode?: string; expiresInMinutes: number }>('/auth/code', { email }), []);
  const verify = useCallback(async (email: string, code: string, name?: string) => {
    const r = await post<{ account: Account; retailer?: RetailerShop | null }>('/auth/verify', { email, code, ...(name ? { name } : {}) });
    setAccount(r.account);
    setRetailer(r.retailer ?? null);
    return r.account;
  }, []);
  const signOut = useCallback(async () => {
    await post('/auth/logout', {});
    setAccount(null);
    setRetailer(null);
  }, []);

  const [alerts, setAlerts] = useState<BackInStockAlert[]>([]);
  const signedIn = Boolean(account);
  useEffect(() => {
    if (!signedIn) {
      setAlerts([]);
      return;
    }
    const load = () => api<{ items: BackInStockAlert[] }>('/me/alerts').then((r) => setAlerts(r.items), () => {});
    void load();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), 20_000);
    return () => window.clearInterval(t);
  }, [signedIn]);
  const addAlert = useCallback(async (productId: number, city: string) => {
    setAlerts((await post<{ items: BackInStockAlert[] }>('/me/alerts', { productId, city })).items);
  }, []);
  const removeAlert = useCallback(async (id: number) => {
    setAlerts((await del<{ items: BackInStockAlert[] }>(`/me/alerts/${id}`)).items);
  }, []);

  const value = useMemo(
    () => ({ account, retailer, requestCode, verify, signOut, alerts, addAlert, removeAlert }),
    [account, retailer, requestCode, verify, signOut, alerts, addAlert, removeAlert],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error('useAccount outside AccountProvider');
  return ctx;
}

/* ---------------- Cart ---------------- */

/** Why the shopper couldn't add an item: drives the "out of stock for you" popup. */
export interface Unavailable {
  productId: number;
  name: string;
  city: string;
  reason: 'sold_out' | 'being_paid_for' | 'in_someone_cart';
  message: string;
}

interface CartCtx {
  cart: Cart | null;
  count: number;
  hasShortItems: boolean;
  refresh: () => Promise<void>;
  /** Resolves true if added; false if it's unavailable to this shopper (the popup is then shown). */
  add: (productId: number, qty?: number) => Promise<boolean>;
  setQty: (productId: number, qty: number) => Promise<void>;
  remove: (productId: number) => Promise<void>;
  unavailable: Unavailable | null;
  showUnavailable: (u: Unavailable | null) => void;
}

const CartContext = createContext<CartCtx | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const { city } = useCity();
  const { toast } = useToast();
  // Signing in or out switches whose cart this is (the account's, on every device), so reload it.
  const accountId = useContext(AccountContext)?.account?.id ?? null;
  const [cart, setCart] = useState<Cart | null>(null);

  const refresh = useCallback(async () => {
    if (!city) return;
    try {
      setCart(await api<Cart>(`/cart?city=${city}`));
    } catch {
      /* keep the last known cart; pages show their own errors */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, accountId]);

  // Load on city change, then refresh every 5 s while visible so "short" warnings stay honest.
  useEffect(() => {
    setCart(null);
    void refresh();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const [unavailable, showUnavailable] = useState<Unavailable | null>(null);

  const add = useCallback(
    async (productId: number, qty = 1) => {
      if (!city) return false;
      try {
        setCart(await post<Cart>('/cart/items', { city, productId, qty }));
        beat(productId, 'cart', 0); // the retailer dashboard's "Live now"
        return true;
      } catch (e) {
        // Someone else holds it, it's being paid for, or it's sold out: explain and offer partners.
        if (e instanceof ApiError && e.code === 'OUT_OF_STOCK') {
          const d = (e.details ?? {}) as Omit<Partial<Unavailable>, 'reason'> & { reason?: Unavailable['reason'] | 'already_yours' };
          // Signed in on another device too: it's already in this account's cart.
          if (d.reason === 'already_yours') {
            toast(e.message, { label: 'View cart', to: '/cart' });
            return false;
          }
          showUnavailable({
            productId, name: d.name ?? 'This item', city, reason: d.reason ?? 'sold_out', message: e.message,
          });
          return false;
        }
        throw e;
      }
    },
    [city, toast],
  );
  const setQty = useCallback(
    async (productId: number, qty: number) => {
      if (!city) return;
      setCart(await patch<Cart>(`/cart/items/${productId}`, { city, qty }));
    },
    [city],
  );
  const remove = useCallback(
    async (productId: number) => {
      if (!city) return;
      setCart(await del<Cart>(`/cart/items/${productId}?city=${city}`));
    },
    [city],
  );

  const value = useMemo<CartCtx>(
    () => ({
      cart,
      count: cart?.items.reduce((n, i) => n + i.qty, 0) ?? 0,
      hasShortItems: cart?.items.some((i) => i.shortBy > 0) ?? false,
      refresh,
      add,
      setQty,
      remove,
      unavailable,
      showUnavailable,
    }),
    [cart, refresh, add, setQty, remove, unavailable],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart outside CartProvider');
  return ctx;
}
