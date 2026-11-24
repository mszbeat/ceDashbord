const DEFAULT_ADMIN_ROLES = ['admin', 'ce-admin'];

/**
 * Mirrors backend `requireAdminSession`: exact configured role plus scoped admin
 * roles such as `admin.bank` and `admin:reports`.
 */
export function hasAdminRole(roles, configuredRoles = process.env.CE_ADMIN_ROLES) {
  const allowed = String(configuredRoles || DEFAULT_ADMIN_ROLES.join(','))
    .split(',')
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
  return (Array.isArray(roles) ? roles : []).some((role) => {
    const value = String(role || '').trim().toLowerCase();
    return value && allowed.some((admin) =>
      value === admin || value.startsWith(`${admin}.`) || value.startsWith(`${admin}:`),
    );
  });
}
