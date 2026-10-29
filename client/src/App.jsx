
import { useCallback, useEffect, useState } from 'react'
import './App.css'

const API = 'http://localhost:5000'

function formatPrice(price) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Number(price))
}

function App() {
  const [product, setProduct] = useState(null)
  const [loadingProduct, setLoadingProduct] = useState(true)
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const [orderId, setOrderId] = useState('')
  const [orderStatus, setOrderStatus] = useState('')
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState('')

  const [checkoutKey, setCheckoutKey] = useState(() => crypto.randomUUID())

  const loadProduct = useCallback(async () => {
    try {
      const response = await fetch(`${API}/api/product`)
      if (!response.ok) throw new Error('Could not load product')

      const data = await response.json()
      setProduct(data)
    } catch {
      setMessage('Unable to connect to the FlashSale server.')
      setMessageType('error')
    } finally {
      setLoadingProduct(false)
    }
  }, [])

  useEffect(() => {
  const timeout = setTimeout(() => {
    loadProduct()
  }, 0)

  const interval = setInterval(loadProduct, 3000)

  return () => {
    clearTimeout(timeout)
    clearInterval(interval)
  }
}, [loadProduct])

  // Poll the order until the worker finishes processing it.
  useEffect(() => {
    if (!orderId || orderStatus !== 'PENDING') return

    let active = true
    let timer

    const checkOrder = async () => {
      try {
        const response = await fetch(`${API}/api/orders/${orderId}`)
        if (!response.ok) throw new Error('Order lookup failed')

        const order = await response.json()
        if (!active) return

        if (order.status === 'CONFIRMED') {
          setOrderStatus('CONFIRMED')
          setMessage('Your order is confirmed. You got it!')
          setMessageType('success')

          setCheckoutKey(crypto.randomUUID())
          loadProduct()
          return
        }

        if (order.status === 'FAILED') {
          setOrderStatus('FAILED')
          setMessage('The order could not be completed. Please try again.')
          setMessageType('error')
          loadProduct()
          return
        }
      } catch {
        // Retry the status check on the next interval.
      }

      if (active) timer = setTimeout(checkOrder, 1500)
    }

    timer = setTimeout(checkOrder, 1000)

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [orderId, orderStatus, loadProduct])

  
async function handleCheckout() {
  if (checkoutLoading || !product || orderStatus === 'CONFIRMED') return

  setCheckoutLoading(true)
  setMessage('')
  setMessageType('')

  try {
    const response = await fetch(`${API}/api/checkout`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': checkoutKey,
      },
    })

    const data = await response.json()

    if (!response.ok) {
      setMessage(data.error || 'Checkout could not be completed.')
      setMessageType('error')

      // Sold out is a definite rejection; other errors may be uncertain.
      if (response.status === 409) {
        setCheckoutKey(crypto.randomUUID())
      }

      await loadProduct()
      return
    }

    setOrderId(data.orderId || data.id)
    setOrderStatus(data.status)
    setMessage('Checkout accepted. Confirming your order…')
    setMessageType('info')
    await loadProduct()
  } catch {
    // Keep the same key so a retry can reuse the checkout attempt.
    setMessage(
      'Could not reach the checkout service. Retry carefully; the order may have been accepted.'
    )
    setMessageType('error')
  } finally {
    setCheckoutLoading(false)
  }
}

  const stock = Number(product?.availableForReservation ?? 0)
  const soldOut = product && stock <= 0
  const processing = checkoutLoading || orderStatus === 'PENDING'

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="FlashSale home">
          <span className="brand-mark">F</span>
          <span>flash<span className="brand-accent">sale</span></span>
        </a>

        <div className="live-indicator">
          <span className="live-dot" />
          LIVE SALE
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="eyebrow-line" />
            THE DROP EVERYONE'S WAITING FOR
          </div>

          <h1>
            Big deal.
            <br />
            <span>Small window.</span>
          </h1>

          <p className="hero-description">
            One incredible device. Limited units. When they’re gone, they’re
            gone.
          </p>

          <div className="hero-points">
            <div><span>✓</span> Live inventory</div>
            <div><span>✓</span> Secure checkout flow</div>
            <div><span>✓</span> Instant order updates</div>
          </div>
        </div>

        <div className="product-art" aria-label="Smartphone illustration">
          <div className="art-glow" />
          <div className="art-ring ring-one" />
          <div className="art-ring ring-two" />
          <div className="phone">
            <div className="phone-screen">
              <div className="phone-camera" />
              <div className="phone-wallpaper">
                <div className="wallpaper-orb orb-one" />
                <div className="wallpaper-orb orb-two" />
                <div className="wallpaper-orb orb-three" />
              </div>
              <div className="phone-time">08:00</div>
              <div className="phone-caption">YOUR NEXT<br />UPGRADE.</div>
            </div>
          </div>
          <div className="floating-tag">LIMITED DROP <span>✦</span></div>
          <div className="floating-price">₹29,999</div>
        </div>
      </section>

      <section className="sale-layout">
        <div className="section-heading">
          <div>
            <span className="section-kicker">THE FEATURED DROP</span>
            <h2>Today’s pick.</h2>
          </div>
          <span className="edition-label">EDITION 001 / 001</span>
        </div>

        <article className="product-card">
          <div className="product-visual">
            <div className="visual-badge">FLASH PICK</div>
            <div className="mini-phone">
              <div className="mini-camera" />
              <div className="mini-lens lens-one" />
              <div className="mini-lens lens-two" />
              <div className="mini-lens lens-three" />
              <div className="mini-flash" />
              <div className="mini-logo">✦</div>
            </div>
            <div className="visual-caption">DESIGNED FOR<br />WHAT’S NEXT.</div>
          </div>

          <div className="product-details">
            <div className="product-overline">
              <span>SMART TECH</span>
              <span className="rating">★ <span>FLASHSALE EXCLUSIVE</span></span>
            </div>

            <h3>{product?.product_name || 'FlashSale Smartphone'}</h3>
            <p className="product-description">
              A premium smartphone experience, available for a limited time.
            </p>

            <div className="price-row">
              <div>
                <span className="price-label">FLASH PRICE</span>
                <div className="price">
                  {product ? formatPrice(product.price) : '₹29,999'}
                </div>
              </div>
              <div className="original-price">
                <span>OFFER</span>
                <strong>LIMITED</strong>
              </div>
            </div>

            <div className="stock-panel">
              <div className="stock-heading">
                <span>AVAILABLE TO RESERVE</span>
                <strong>
                  {loadingProduct ? 'Loading…' : `${stock} units`}
                </strong>
              </div>
              <div
                className="stock-track"
                role="progressbar"
                aria-label="Available inventory"
                aria-valuemin={0}
                aria-valuemax={500}
                aria-valuenow={Math.max(0, Math.min(500, stock))}
              >
                <div
                  className="stock-fill"
                  style={{
                    width: `${Math.max(0, Math.min(100, (stock / 500) * 100))}%`,
                  }}
                />
              </div>
              <p className="stock-note">
                {soldOut
                  ? 'All units have been reserved.'
                  : stock <= 50
                    ? 'Moving fast — don’t wait too long.'
                    : 'Inventory updates live as units are reserved.'}
              </p>
            </div>

            <button
              className="checkout-button"
              onClick={handleCheckout}
              disabled={
                loadingProduct ||
                !product ||
                soldOut ||
                processing ||
                orderStatus === 'CONFIRMED'
              }
            >
              {checkoutLoading
                ? 'Placing order…'
                : orderStatus === 'PENDING'
                  ? 'Confirming order…'
                  : soldOut
                    ? 'Sold out'
                    : orderStatus === 'CONFIRMED'
                      ? 'Order confirmed ✓'
                      : 'Grab this deal'}
              {!soldOut && !processing && orderStatus !== 'CONFIRMED' && (
                <span aria-hidden="true">↗</span>
              )}
            </button>

            <p className="checkout-note">
              <span>⌑</span> One unit per checkout · Live inventory reservation
            </p>

            {message && (
              <div
                className={`notice notice-${messageType}`}
                role="status"
                aria-live="polite"
              >
                <span className="notice-icon">
                  {messageType === 'success'
                    ? '✓'
                    : messageType === 'error'
                      ? '!'
                      : '↻'}
                </span>
                <div>
                  <strong>
                    {messageType === 'success'
                      ? 'You’re all set'
                      : messageType === 'error'
                        ? 'Something went wrong'
                        : 'Hang tight'}
                  </strong>
                  <p>{message}</p>
                  {orderId && (
                    <small>Order ID: {orderId}</small>
                  )}
                </div>
              </div>
            )}
          </div>
        </article>
      </section>

      <section className="trust-strip">
        <div><span className="trust-icon">01</span><p><strong>Live inventory</strong><br />Stock refreshes automatically</p></div>
        <div><span className="trust-icon">02</span><p><strong>Fast reservation</strong><br />Atomic inventory protection</p></div>
        <div><span className="trust-icon">03</span><p><strong>Order tracking</strong><br />Updates from the checkout worker</p></div>
      </section>

      <footer className="footer">
        <a className="brand footer-brand" href="/">
          <span className="brand-mark">F</span>
          <span>flash<span className="brand-accent">sale</span></span>
        </a>
        <p>One drop. One moment. Make it count.</p>
        <span className="footer-status"><span className="live-dot" /> SYSTEM ONLINE</span>
      </footer>
    </main>
  )
}

export default App
