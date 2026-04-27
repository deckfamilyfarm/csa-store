import React, { useEffect, useState } from "react";
import { adminGet } from "../adminApi.js";

const ORDER_DEFAULT_PAGE_SIZE = 50;
const ORDER_PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

function formatMoney(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `$${numeric.toFixed(2)}` : "n/a";
}

function formatCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString() : "0";
}

function formatDateTime(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString();
}

function formatDate(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleDateString();
}

function toQueryString(params) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || typeof value === "undefined") return;
    const normalized = String(value).trim();
    if (!normalized) return;
    query.set(key, normalized);
  });
  return query.toString();
}

function createOrderFilterState(overrides = {}) {
  return {
    search: "",
    fulfillmentSite: "",
    vendor: "",
    category: "",
    status: "",
    paymentStatus: "",
    month: "",
    cycle: "",
    ...overrides
  };
}

function orderFiltersEqual(left = {}, right = {}) {
  return (
    String(left.search || "") === String(right.search || "") &&
    String(left.fulfillmentSite || "") === String(right.fulfillmentSite || "") &&
    String(left.vendor || "") === String(right.vendor || "") &&
    String(left.category || "") === String(right.category || "") &&
    String(left.status || "") === String(right.status || "") &&
    String(left.paymentStatus || "") === String(right.paymentStatus || "") &&
    String(left.month || "") === String(right.month || "") &&
    String(left.cycle || "") === String(right.cycle || "")
  );
}

function describeAppliedOrderFilters(filters = {}) {
  const parts = [];
  if (filters.search) parts.push(`Search: "${filters.search}"`);
  if (filters.fulfillmentSite) parts.push(`Site: ${filters.fulfillmentSite}`);
  if (filters.vendor) parts.push(`Vendor: ${filters.vendor}`);
  if (filters.category) parts.push(`Category: ${filters.category}`);
  if (filters.status) parts.push(`Status: ${filters.status}`);
  if (filters.paymentStatus) parts.push(`Payment: ${filters.paymentStatus}`);
  if (filters.month) parts.push(`Month: ${filters.month}`);
  if (filters.cycle === "tuesday") parts.push("Cycle: Tuesday Drops");
  if (filters.cycle === "fridaySaturday") parts.push("Cycle: Friday/Saturday Drops");
  return parts.length ? parts.join(" | ") : "All orders";
}

function normalizeOrderDetail(order = {}) {
  return {
    localLineOrderId: order.localLineOrderId ?? order.local_line_order_id ?? null,
    status: order.status || "",
    priceListId: order.priceListId ?? order.price_list_id ?? null,
    priceListName: order.priceListName ?? order.price_list_name ?? "",
    customerId: order.customerId ?? order.customer_id ?? null,
    customerName: order.customerName ?? order.customer_name ?? "",
    createdAtRemote: order.createdAtRemote ?? order.created_at_remote ?? null,
    updatedAtRemote: order.updatedAtRemote ?? order.updated_at_remote ?? null,
    openedAtRemote: order.openedAtRemote ?? order.opened_at_remote ?? null,
    fulfillmentStrategyId:
      order.fulfillmentStrategyId ?? order.fulfillment_strategy_id ?? null,
    fulfillmentStrategyName:
      order.fulfillmentStrategyName ?? order.fulfillment_strategy_name ?? "",
    fulfillmentType: order.fulfillmentType ?? order.fulfillment_type ?? "",
    fulfillmentStatus: order.fulfillmentStatus ?? order.fulfillment_status ?? "",
    fulfillmentDate: order.fulfillmentDate ?? order.fulfillment_date ?? null,
    pickupStartTime: order.pickupStartTime ?? order.pickup_start_time ?? "",
    pickupEndTime: order.pickupEndTime ?? order.pickup_end_time ?? "",
    paymentStatus: order.paymentStatus ?? order.payment_status ?? "",
    subtotal: order.subtotal,
    tax: order.tax,
    total: order.total,
    discount: order.discount,
    productCount: order.productCount ?? order.product_count ?? 0,
    rawJson: order.rawJson ?? order.raw_json ?? null
  };
}

export function AdminOrdersSection({ token }) {
  const [draftFilters, setDraftFilters] = useState(createOrderFilterState);
  const [appliedFilters, setAppliedFilters] = useState(createOrderFilterState);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(ORDER_DEFAULT_PAGE_SIZE);
  const [ordersState, setOrdersState] = useState({
    loading: false,
    error: "",
    data: null
  });
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [selectedOrderState, setSelectedOrderState] = useState({
    loading: false,
    error: "",
    data: null
  });

  useEffect(() => {
    let cancelled = false;

    async function loadOrders() {
      setOrdersState((prev) => ({ ...prev, loading: true, error: "" }));
      try {
        const query = toQueryString({
          search: appliedFilters.search,
          fulfillmentSite: appliedFilters.fulfillmentSite,
          vendor: appliedFilters.vendor,
          category: appliedFilters.category,
          status: appliedFilters.status,
          paymentStatus: appliedFilters.paymentStatus,
          month: appliedFilters.month,
          cycle: appliedFilters.cycle,
          page,
          pageSize
        });
        const response = await adminGet(`orders${query ? `?${query}` : ""}`, token);
        if (cancelled) return;

        const nextOrders = Array.isArray(response?.orders) ? response.orders : [];
        setOrdersState({
          loading: false,
          error: "",
          data: response
        });
        setSelectedOrderId((current) => {
          if (nextOrders.some((order) => Number(order.localLineOrderId) === Number(current))) {
            return current;
          }
          return nextOrders[0]?.localLineOrderId || null;
        });
      } catch (error) {
        if (cancelled) return;
        setOrdersState({
          loading: false,
          error: error?.message || "Failed to load orders.",
          data: null
        });
        setSelectedOrderId(null);
      }
    }

    loadOrders();
    return () => {
      cancelled = true;
    };
  }, [appliedFilters, page, pageSize, token]);

  useEffect(() => {
    if (!selectedOrderId) {
      setSelectedOrderState({
        loading: false,
        error: "",
        data: null
      });
      return;
    }

    let cancelled = false;

    async function loadOrderDetail() {
      setSelectedOrderState({
        loading: true,
        error: "",
        data: null
      });
      try {
        const response = await adminGet(`orders/${selectedOrderId}`, token);
        if (cancelled) return;
        setSelectedOrderState({
          loading: false,
          error: "",
          data: {
            order: normalizeOrderDetail(response?.order || {}),
            entries: Array.isArray(response?.entries) ? response.entries : []
          }
        });
      } catch (error) {
        if (cancelled) return;
        setSelectedOrderState({
          loading: false,
          error: error?.message || "Failed to load order details.",
          data: null
        });
      }
    }

    loadOrderDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedOrderId, token]);

  const orders = ordersState.data?.orders || [];
  const pagination = ordersState.data?.pagination || {
    page: 1,
    pageSize,
    totalRows: 0,
    totalPages: 1
  };
  const filters = ordersState.data?.filters || {
    fulfillmentSites: [],
    vendors: [],
    categories: [],
    statuses: [],
    paymentStatuses: [],
    months: []
  };
  const metrics = ordersState.data?.metrics || {};
  const overview = metrics.overview || {};
  const monthlyTrend = metrics.monthlyTrend || [];
  const selectedOrder = selectedOrderState.data?.order || null;
  const selectedEntries = selectedOrderState.data?.entries || [];
  const showingCount = orders.length;
  const hasPendingFilterChanges = !orderFiltersEqual(draftFilters, appliedFilters);
  const appliedFilterLabel = describeAppliedOrderFilters(appliedFilters);

  function updateFilter(key) {
    return (event) => {
      const value = event.target.value;
      setDraftFilters((prev) => ({
        ...prev,
        [key]: key === "search" ? value : String(value || "")
      }));
    };
  }

  function handleApplyFilters() {
    setAppliedFilters({
      search: String(draftFilters.search || "").trim(),
      fulfillmentSite: String(draftFilters.fulfillmentSite || "").trim(),
      vendor: String(draftFilters.vendor || "").trim(),
      category: String(draftFilters.category || "").trim(),
      status: String(draftFilters.status || "").trim(),
      paymentStatus: String(draftFilters.paymentStatus || "").trim(),
      month: String(draftFilters.month || "").trim(),
      cycle: String(draftFilters.cycle || "").trim()
    });
    setPage(1);
  }

  function handleClearFilters() {
    const cleared = createOrderFilterState();
    setDraftFilters(cleared);
    setAppliedFilters(cleared);
    setPage(1);
  }

  return (
    <section className="admin-section">
      <h3>Orders</h3>
      <div className="small">
        Review Local Line orders stored in the local database. Orders are shown newest first, and
        the filters below control the table and summary.
      </div>

      <div className="pricelist-toolbar orders-toolbar">
        <div className="filters pricelist-filters orders-filters">
          <label className="filter-field product-search-filter">
            <span className="small">Search orders</span>
            <input
              className="input"
              type="search"
              placeholder="Order, customer, dropsite, price list"
              value={draftFilters.search}
              onChange={updateFilter("search")}
            />
          </label>

          <label className="filter-field">
            <span className="small">Fulfillment site</span>
            <select
              className="select"
              value={draftFilters.fulfillmentSite}
              onChange={updateFilter("fulfillmentSite")}
            >
              <option value="">All sites</option>
              {filters.fulfillmentSites.map((site) => (
                <option key={`orders-site-${site}`} value={site}>
                  {site}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-field">
            <span className="small">Status</span>
            <select className="select" value={draftFilters.status} onChange={updateFilter("status")}>
              <option value="">All statuses</option>
              {filters.statuses.map((value) => (
                <option key={`orders-status-${value}`} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-field">
            <span className="small">Vendor</span>
            <select className="select" value={draftFilters.vendor} onChange={updateFilter("vendor")}>
              <option value="">All vendors</option>
              {filters.vendors.map((value) => (
                <option key={`orders-vendor-${value}`} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-field">
            <span className="small">Category</span>
            <select className="select" value={draftFilters.category} onChange={updateFilter("category")}>
              <option value="">All categories</option>
              {filters.categories.map((value) => (
                <option key={`orders-category-${value}`} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-field">
            <span className="small">Payment</span>
            <select
              className="select"
              value={draftFilters.paymentStatus}
              onChange={updateFilter("paymentStatus")}
            >
              <option value="">All payment statuses</option>
              {filters.paymentStatuses.map((value) => (
                <option key={`orders-payment-${value}`} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-field">
            <span className="small">Month</span>
            <select className="select" value={draftFilters.month} onChange={updateFilter("month")}>
              <option value="">All months</option>
              {filters.months.map((value) => (
                <option key={`orders-month-${value}`} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-field">
            <span className="small">Cycle</span>
            <select className="select" value={draftFilters.cycle} onChange={updateFilter("cycle")}>
              <option value="">All cycles</option>
              <option value="tuesday">Tuesday Drops</option>
              <option value="fridaySaturday">Friday/Saturday Drops</option>
            </select>
          </label>
        </div>

        <div className="pricelist-toolbar-actions">
          <button className="button" type="button" onClick={handleApplyFilters}>
            Apply Filters
          </button>
          <button className="button alt" type="button" onClick={handleClearFilters}>
            Clear Filters
          </button>
          {hasPendingFilterChanges ? (
            <div className="small">Filters changed. Click Apply Filters to refresh the table and metrics.</div>
          ) : (
            <div className="small">Filters applied below.</div>
          )}
        </div>

        <div className="pricelist-pagination">
          <label className="filter-field pricelist-page-size">
            <span className="small">Rows</span>
            <select
              className="select"
              value={String(pageSize)}
              onChange={(event) => {
                setPageSize(Number(event.target.value) || ORDER_DEFAULT_PAGE_SIZE);
                setPage(1);
              }}
            >
              {ORDER_PAGE_SIZE_OPTIONS.map((option) => (
                <option key={`orders-page-size-${option}`} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <div className="small pricelist-page-meta">
            Showing {showingCount} of {formatCount(pagination.totalRows)} orders
          </div>
          <div className="small pricelist-page-meta">
            Page {formatCount(pagination.page)} of {formatCount(pagination.totalPages)}
          </div>
          <button
            className="button alt"
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={pagination.page <= 1}
          >
            Previous
          </button>
          <button
            className="button alt"
            type="button"
            onClick={() =>
              setPage((current) => Math.min(Number(pagination.totalPages || 1), current + 1))
            }
            disabled={pagination.page >= pagination.totalPages}
          >
            Next
          </button>
        </div>
      </div>

      <div className="response-card">
        <div className="title">Current Filters</div>
        <div className="small">{appliedFilterLabel}</div>
        {ordersState.loading ? <div className="small">Refreshing results...</div> : null}
      </div>

      {ordersState.error ? <div className="small">{ordersState.error}</div> : null}

      <div className="audit-summary-grid orders-summary-grid">
        <div className="response-card">
          <div className="title">Orders</div>
          <div className="small">{formatCount(overview.orderCount)} matching orders</div>
        </div>
        <div className="response-card">
          <div className="title">Revenue</div>
          <div className="small">{formatMoney(overview.revenue)}</div>
        </div>
        <div className="response-card">
          <div className="title">Average Order</div>
          <div className="small">{formatMoney(overview.averageOrderValue)}</div>
        </div>
        <div className="response-card">
          <div className="title">Customers</div>
          <div className="small">{formatCount(overview.customerCount)}</div>
        </div>
      </div>

      <div className="response-card orders-trend-card">
        <div className="title">Monthly Trend</div>
        <div className="response-list orders-performance-list">
          {monthlyTrend.length ? (
            monthlyTrend.map((row) => (
              <div className="response-card" key={`orders-trend-${row.month}`}>
                <div className="title">{row.month}</div>
                <div className="small">
                  {formatCount(row.orderCount)} orders · {formatMoney(row.revenue)} revenue
                </div>
                <div className="small">{formatCount(row.siteCount)} fulfillment sites</div>
              </div>
            ))
          ) : (
            <div className="small">No monthly trend data yet.</div>
          )}
        </div>
      </div>

      <div className="admin-table-shell orders-table-shell">
        <div className="admin-table-body-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Created</th>
                <th>Fulfillment</th>
                <th>Cycle</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Price List</th>
                <th>Total</th>
                <th>Items</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => {
                const isSelected =
                  Number(selectedOrderId) === Number(order.localLineOrderId);
                return (
                  <tr
                    key={`admin-order-row-${order.localLineOrderId}`}
                    className={isSelected ? "orders-row-selected" : ""}
                  >
                    <td>{formatDateTime(order.createdAtRemote)}</td>
                    <td>
                      <div>{order.fulfillmentStrategyName || "Unassigned"}</div>
                      <div className="small">
                        {formatDate(order.fulfillmentDate)}
                        {order.pickupStartTime || order.pickupEndTime
                          ? ` · ${[order.pickupStartTime, order.pickupEndTime].filter(Boolean).join(" - ")}`
                          : ""}
                      </div>
                    </td>
                    <td>
                      <div>{order.cycleLabel || "n/a"}</div>
                      <div className="small">{formatDate(order.cycleStartDate)}</div>
                    </td>
                    <td>{order.customerName || "n/a"}</td>
                    <td>{order.status || "n/a"}</td>
                    <td>{order.paymentStatus || "n/a"}</td>
                    <td>{order.priceListName || "n/a"}</td>
                    <td>{formatMoney(order.total)}</td>
                    <td>{formatCount(order.productCount)}</td>
                    <td>
                      <button
                        className="button alt"
                        type="button"
                        onClick={() => setSelectedOrderId(order.localLineOrderId)}
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!orders.length && !ordersState.loading ? (
                <tr>
                  <td colSpan={10}>
                    No orders found. Run a Local Line order pull from the <strong>Local Line</strong>{" "}
                    section if you have not populated the local order cache yet.
                  </td>
                </tr>
              ) : null}
              {ordersState.loading ? (
                <tr>
                  <td colSpan={10}>Loading orders...</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="response-card orders-detail-card">
        <div className="title">
          {selectedOrder
            ? `Order ${selectedOrder.localLineOrderId}`
            : "Order Details"}
        </div>
        {selectedOrderState.error ? <div className="small">{selectedOrderState.error}</div> : null}
        {selectedOrderState.loading && !selectedOrder ? <div className="small">Loading order details...</div> : null}
        {!selectedOrder && !selectedOrderState.loading ? (
          <div className="small">Select an order to review its line items and fulfillment details.</div>
        ) : null}
        {selectedOrder ? (
          <>
            <div className="orders-detail-meta">
              <div className="response-card">
                <div className="title">Customer</div>
                <div className="small">{selectedOrder.customerName || "n/a"}</div>
                <div className="small">Order status: {selectedOrder.status || "n/a"}</div>
                <div className="small">Payment: {selectedOrder.paymentStatus || "n/a"}</div>
              </div>
              <div className="response-card">
                <div className="title">Fulfillment</div>
                <div className="small">{selectedOrder.fulfillmentStrategyName || "Unassigned"}</div>
                <div className="small">
                  Date: {formatDate(selectedOrder.fulfillmentDate)}
                </div>
                <div className="small">
                  Window: {[selectedOrder.pickupStartTime, selectedOrder.pickupEndTime].filter(Boolean).join(" - ") || "n/a"}
                </div>
                <div className="small">Type: {selectedOrder.fulfillmentType || "n/a"}</div>
              </div>
              <div className="response-card">
                <div className="title">Amounts</div>
                <div className="small">Subtotal: {formatMoney(selectedOrder.subtotal)}</div>
                <div className="small">Tax: {formatMoney(selectedOrder.tax)}</div>
                <div className="small">Discount: {formatMoney(selectedOrder.discount)}</div>
                <div className="small">Total: {formatMoney(selectedOrder.total)}</div>
              </div>
              <div className="response-card">
                <div className="title">Audit</div>
                <div className="small">Created: {formatDateTime(selectedOrder.createdAtRemote)}</div>
                <div className="small">Updated: {formatDateTime(selectedOrder.updatedAtRemote)}</div>
                <div className="small">Opened: {formatDateTime(selectedOrder.openedAtRemote)}</div>
                <div className="small">Price list: {selectedOrder.priceListName || "n/a"}</div>
              </div>
            </div>

            <div className="admin-table-shell orders-entry-table-shell">
              <div className="admin-table-body-scroll">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Vendor</th>
                      <th>Product</th>
                      <th>Package</th>
                      <th>Category</th>
                      <th>Units</th>
                      <th>Inventory Qty</th>
                      <th>Price</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedEntries.map((entry) => (
                      <tr key={`order-entry-${entry.localLineOrderEntryId}`}>
                        <td>{entry.vendorName || "n/a"}</td>
                        <td>{entry.productName || "n/a"}</td>
                        <td>{entry.packageName || "n/a"}</td>
                        <td>{entry.categoryName || "n/a"}</td>
                        <td>{formatCount(entry.unitQuantity)}</td>
                        <td>{formatCount(entry.inventoryQuantity)}</td>
                        <td>{formatMoney(entry.price)}</td>
                        <td>{formatMoney(entry.totalPrice)}</td>
                      </tr>
                    ))}
                    {!selectedEntries.length ? (
                      <tr>
                        <td colSpan={8}>No line items stored for this order.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
