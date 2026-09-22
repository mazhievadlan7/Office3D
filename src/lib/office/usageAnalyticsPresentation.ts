"use client";

import { LOCALE } from "@/lib/i18n";

export const toDateInputValue = (date: Date) => date.toISOString().slice(0, 10);

export const getDefaultUsageAnalyticsRange = () => {
  const endDate = toDateInputValue(new Date());
  const start = new Date();
  start.setDate(start.getDate() - 6);
  return {
    startDate: toDateInputValue(start),
    endDate,
  };
};

export const formatCurrency = (value: number | null | undefined) => {
  const amount = value ?? 0;
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amount < 10 ? 2 : 0,
    maximumFractionDigits: amount < 10 ? 2 : 0,
  }).format(amount);
};

export const formatNumber = (value: number | null | undefined) =>
  new Intl.NumberFormat(LOCALE).format(value ?? 0);
