import { createFileRoute } from '@tanstack/react-router';
import { TenantHome } from './b.$slug';

export const Route = createFileRoute('/b/$slug/')({
  component: TenantHome,
});