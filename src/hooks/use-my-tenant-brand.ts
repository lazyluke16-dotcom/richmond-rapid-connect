import { useEffect, useState } from 'react';
import { getMyBusiness, type EditableBusiness } from '@/lib/business-settings.functions';
import type { TenantBrand } from '@/components/AppShell';

export function useMyTenantBrand(): TenantBrand | undefined {
  const [b, setB] = useState<EditableBusiness | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getMyBusiness();
        if (!cancelled) setB(res);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);
  if (!b) return undefined;
  return { name: b.name, phone: b.public_phone, location: null, licence: null, slug: b.slug };
}
