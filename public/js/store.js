// Shared client state: the reference data every view needs, loaded once and refreshed on demand.

import { api } from './util.js';

const state = {
  stores: [],
  suppliers: [],
  categories: [],
  activeStoreId: Number(localStorage.getItem('activeStoreId')) || null,
};

const listeners = new Set();

export function getState() { return state; }

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function notify() { for (const fn of listeners) fn(state); }

export async function refreshReference() {
  const [stores, suppliers, categories] = await Promise.all([
    api('/stores'),
    api('/suppliers'),
    api('/categories'),
  ]);
  state.stores = stores;
  state.suppliers = suppliers;
  state.categories = categories;
  if (!state.activeStoreId || !stores.some((s) => s.id === state.activeStoreId)) {
    state.activeStoreId = stores[0]?.id || null;
    localStorage.setItem('activeStoreId', String(state.activeStoreId || ''));
  }
  notify();
  return state;
}

export function setActiveStore(id) {
  state.activeStoreId = Number(id) || null;
  localStorage.setItem('activeStoreId', String(state.activeStoreId || ''));
  notify();
}

export function activeStore() { return state.stores.find((s) => s.id === state.activeStoreId) || null; }

export function storeOptions() { return state.stores.map((s) => ({ value: s.id, label: s.name })); }

export function supplierOptions(includeAll = false) {
  const list = state.suppliers.map((s) => ({ value: s.id, label: s.name }));
  return includeAll ? [{ value: '', label: 'All suppliers' }, ...list] : list;
}

export function categoryOptions(includeAll = true) {
  const list = state.categories.map((c) => ({ value: c, label: c }));
  return includeAll ? [{ value: '', label: 'All categories' }, ...list] : list;
}
