module.exports = (router) => {
  router
    .setRoute('/api/auth/register', 'auth-controller.signUp')
    .method('POST')
    .validate();

  router
    .setRoute('/api/auth/login', 'auth-controller.login')
    .method('PUT')
    .validate()
    .checkAccess(true);
  router
    .setRoute('/api/auth/logout', 'auth-controller.logout')
    .method('POST')
    .checkAccess(true);
  router
    .setRoute('/api/auth/me', 'auth-controller.me')
    .method('GET')
    .checkAccess(true);

  router
    .setRoute('/api/auth/role', 'auth-controller.updateInfo')
    .method('POST')
    .validate()
    .checkAccess(true);
  router
    .setRoute('employees', 'employee-controller.getEmployees')
    .method('GET')
    .checkAccess(true);
  router
    .setRoute('employees', 'employee-controller.addEmployee')
    .method('PUT')
    .validate()
    .checkAccess(true);

};
