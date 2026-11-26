import { useEffect, useLayoutEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { AccountProvider, CartProvider, CityProvider, ToastProvider, useCity } from './state';
import { startTracking, track } from './track';
import { CityPicker, Footer, Header, StockModal, Toast } from './components/ui';
import { pageEnter, scrollToTop, ScrollTrigger, startSmoothScroll } from './motion';
import { Home } from './pages/Home';
import { Shop } from './pages/Shop';
import { Help, HowItWorks, NotFound, Privacy, Stores, Terms } from './pages/Info';
import { Product } from './pages/Product';
import { CartPage } from './pages/Cart';
import { Checkout } from './pages/Checkout';
import { OrderPage } from './pages/Order';
import { Ops } from './pages/Ops';
import { Customers } from './pages/Customers';
import { RetailerDashboard } from './pages/RetailerDashboard';
import { AccountPage, SignIn } from './pages/Account';
import { Store } from './pages/Store';
import { Saved } from './pages/Saved';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    scrollToTop();
    // New page, new layout: let pinned sections and scroll triggers re-measure.
    requestAnimationFrame(() => ScrollTrigger.refresh());
  }, [pathname]);
  return null;
}

/** Fade each new screen in. "/shop" and "/search" are one screen, so typing a search doesn't flash. */
function PageTransition() {
  const { pathname } = useLocation();
  const screen = pathname === '/search' ? '/shop' : pathname;
  useLayoutEffect(() => {
    pageEnter(document.querySelector('main'));
  }, [screen]);
  return null;
}

/**
 * A shared link's ?city= wins over the saved city on load (state.tsx). Once the shopper switches
 * city, rewrite that param too, or a reload / shared link would snap back to the old city.
 */
function SyncCityParam() {
  const { city } = useCity();
  const [params, setParams] = useSearchParams();
  const urlCity = params.get('city');
  useEffect(() => {
    if (city && urlCity && urlCity.toUpperCase() !== city) {
      const next = new URLSearchParams(params);
      next.set('city', city);
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, urlCity]);
  return null;
}

/** One page_view per screen change (doc/14); clicks are captured globally by startTracking(). */
function TrackPageViews() {
  const { pathname, search } = useLocation();
  useEffect(() => startTracking(), []);
  useEffect(() => {
    track('page_view');
  }, [pathname, search]);
  return null;
}

/** Old links to /search keep working, query and all. */
function SearchRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/shop${search}`} replace />;
}

function Shell() {
  const { city } = useCity();
  const { pathname } = useLocation();
  const isOps = pathname.startsWith('/ops');
  return (
    <>
      <Header />
      {city || isOps ? (
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/shop" element={<Shop />} />
          <Route path="/search" element={<SearchRedirect />} />
          <Route path="/stores" element={<Stores />} />
          <Route path="/store/:slug" element={<Store />} />
          <Route path="/saved" element={<Saved />} />
          <Route path="/how-it-works" element={<HowItWorks />} />
          <Route path="/help" element={<Help />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/p/:id" element={<Product />} />
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/orders/:orderId" element={<OrderPage />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/ops" element={<Ops />} />
          <Route path="/ops/customers" element={<Customers />} />
          <Route path="/retailer" element={<RetailerDashboard />} />
          <Route path="/shop-dashboard" element={<Navigate to="/retailer" replace />} />
          <Route path="/customers" element={<Navigate to="/ops/customers" replace />} />
          <Route path="/ops/customer" element={<Navigate to="/ops/customers" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      ) : (
        <main className="shell page" />
      )}
      <PageTransition />
      <Footer />
      {!isOps && <CityPicker />}
      <StockModal />
      <Toast />
    </>
  );
}

export function App() {
  useEffect(() => startSmoothScroll(), []);
  return (
    <CityProvider>
      <ToastProvider>
        <AccountProvider>
        <CartProvider>
          <ScrollToTop />
          <TrackPageViews />
          <SyncCityParam />
          <Shell />
        </CartProvider>
        </AccountProvider>
      </ToastProvider>
    </CityProvider>
  );
}
