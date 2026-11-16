const BaseController = require('@partFramework/baseController');  
exports.controller = class MyController extends BaseController {
  /**
   * @param {Core} core
   * @param {Schema} schema
   * @param {Config} config
  */
  constructor(
    core,
    schema,
    config,
    partAuthenticationInterface,
    partProfileInterface,
    samadService,
    authentication,
    sessionManager,
    operations,
    profileService,
    transactions,
    rollback,
    employeeService) {

    super(core, schema, config);
    this.sessionManager = sessionManager;
    this.employeeService = employeeService;
    this.samadService = samadService;
    this.rollback = rollback;
    this.transactions = transactions;
    this.operations = operations;
    this.authentication = authentication;
    this.profileService = profileService;
    this.authentication.init(partAuthenticationInterface);
    this.profileService.init(partProfileInterface);
  }

  /**
 * ثبت‌نام کاربر جدید.
 *
 * این متد فرآیند ثبت‌نام را به `this.transactions.signUp` واگذار می‌کند.
 * اگر در نتیجه‌ی اجرای مراحل ثبت‌نام، آیتمی با وضعیت `{ status: "rejected" }` وجود داشته باشد،
 * عملیات جبرانی (Rollback) از طریق `this.rollbacks.signUp` اجرا خواهد شد.
 *
 * @async
 * @param {Object} body - اطلاعات ورودی ثبت‌نام کاربر.
 * @param {string} body.username - نام کاربری یکتا (برای استفاده در فرآیند rollback).
 * @param {Object<string, any>} [trackingHeaders] - هدرهای رهگیری/مانیتورینگ جهت ارسال به سرویس‌های پایین‌دستی.
 * @returns {Promise<{message: string}>} در صورت موفقیت، پیام موفقیت‌آمیز بودن ثبت‌نام را برمی‌گرداند.
 * @throws {Error} در صورت بروز خطا در `this.transactions.signUp` یا `this.rollbacks.signUp` خطا را پرتاب می‌کند.
 */
  async signUp(body, trackingHeaders) {
    const result = await this.transactions.signUp(body, trackingHeaders, this.authentication, this.profileService, this.samadService,this.employeeService);
    const rejected = result.find(rejected => {
      return rejected.status === 'rejected';
    });
    if (rejected) {
      await this.rollback(result, rejected);
    }
    return { message: 'register successfuly.' };
  }

  /**
   * احراز هویت کاربر، دریافت نقش‌ها و ایجاد سشن.
   *
   * روند اجرا:
   * 1) احراز هویت کاربر از طریق `this.authentication.authenticate`
   * 2) دریافت نقش‌های کاربر از طریق `samadService.getRole`
   * 3) ذخیره اطلاعات کاربر در سشن با استفاده از `sessionManager.setSession`
   *
   * @async
   * @param {Object} body - اطلاعات ورود کاربر.
   * @param {string} body.username - نام کاربری.
   * @param {string} [body.password] - رمز عبور کاربر (ارسال به سرویس احراز هویت).
   * @param {Object<string, any>} [trackingHeaders] - هدرهای رهگیری جهت ارسال به سرویس‌های پایین‌دستی.
   * @param {Object} session - شیء سشن (مانند `req.session` در Express) که از متد `set` پشتیبانی می‌کند.
   * @returns {Promise<{message: string}>} در صورت موفقیت، پیام موفقیت‌آمیز بودن ورود را برمی‌گرداند.
   * @throws {Error} در صورت خطا در احراز هویت، دریافت نقش‌ها یا ذخیره سشن، خطا را پرتاب می‌کند.
   */
  async login(body, trackingHeaders, session) {
    await this.authentication.authenticate(body, trackingHeaders);
    const roles = await this.samadService.getRole(body.username);
    await this.sessionManager.setSession(session, body, roles)
      .then()
      .catch(err => {
        throw err; 
      });
    return { message: 'login successfuly' };
  }

  /**
   * خروج کاربر از سیستم (حذف سشن).
   *
   * این متد حذف سشن کاربر را به `sessionManager.removeSession` واگذار می‌کند.
   *
   * @async
   * @param {Object} session - شیء سشن کاربر (مانند `req.session`).
   * @param {Object} response - شیء پاسخ HTTP (مانند `res` در Express) در صورت نیاز توسط session manager.
   * @returns {Promise<{message: string}>} در صورت موفقیت، پیام موفقیت‌آمیز بودن خروج را برمی‌گرداند.
   * @throws {Error} در صورت بروز خطا در حذف سشن، خطا را پرتاب می‌کند.
   */
  async logout(session, response) {
    await this.sessionManager.removeSession(session, response)
      .then()
      .catch(err => {
        throw err; 
      });
    return { message: 'logout successfuly' };
  }

  /**
   * دریافت اطلاعات کاربر بر اساس سشن فعلی.
   *
   * این متد اطلاعات کاربر را از طریق `this.operations.getInfo` و با استفاده از
   * `profileService`وemployeeService دریافت می‌کند.
   *
   * @async
   * @param {Object} session - شیء سشن شامل اطلاعات هویتی کاربر.
   * @param {Object<string, any>} [trackingHeaders] - هدرهای رهگیری جهت ارسال به سرویس‌های پایین‌دستی.
   * @returns {Promise<any>|any} خروجی متد `this.operations.getInfo` (بسته به پیاده‌سازی می‌تواند همگام یا ناهمگام باشد).
   * @throws {Error} در صورت بروز خطا در `this.operations.getInfo`، خطا را پرتاب می‌کند.
   */
  async getInfo(session, trackingHeaders) {
    const result = this.operations.getInfo(session, trackingHeaders, this.profileService,this.employeeService,this.sessionManager);
    return result;
  }

  /**
   * به‌روزرسانی اطلاعات کاربر.
   *
   * فرآیند به‌روزرسانی به `this.transactions.updateInfo` واگذار می‌شود.
   * اگر در نتیجه‌ی عملیات، آیتمی با وضعیت `{ status: "rejected" }` وجود داشته باشد،
   * عملیات جبرانی از طریق `this.rollbacks.updateInfo` اجرا خواهد شد.
   *
   * @async
   * @param {Object} body - اطلاعات ورودی برای به‌روزرسانی (بسته به قرارداد سرویس پروفایل).
   * @param {Object<string, any>} [trackingHeaders] - هدرهای رهگیری جهت ارسال به سرویس‌های پایین‌دستی.
   * @param {Object} session - شیء سشن کاربر (برای تشخیص هویت و زمینه اجرایی).
   * @returns {Promise<{message: string}>} در صورت موفقیت، پیام موفقیت‌آمیز بودن به‌روزرسانی را برمی‌گرداند.
   * @throws {Error} در صورت بروز خطا در `this.transactions.updateInfo` یا `this.rollbacks.updateInfo` خطا را پرتاب می‌کند.
   */
  async updateInfo(body, trackingHeaders, session) {
    const result = await this.transactions.updateInfo(body, session, this.profileService, this.sessionManager,this.employeeService, trackingHeaders);
    const rejected = result.find(rejected => {
      return rejected.status === 'rejected';
    });
    if (rejected) {
      await this.rollback(result, rejected);
    }
    return { message: 'update info successfuly.' };
  }
};

exports.introduceToLoader = BaseController.exportedProperties(
  require('./schema'),
  require('./config')
);