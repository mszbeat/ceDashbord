const BaseController = require('@partFramework/baseController');

exports.controller = class MyController extends BaseController {
  /**
   * @param {Core} core
   * @param {Schema} schema
   * @param {Config} config
   * @param {Dependency1} dependency1
   * @param {Dependency2} dependency2
   */
  constructor(core, schema, config, sessionManager, employeeService, operations) {
    super(core, schema, config);
    this.sessionManager = sessionManager;
    this.employeeService = employeeService;
    this.operations = operations;
  }

  /**
 * دریافت لیست کارمندان زیرمجموعه کاربر جاری.
 *
 * روند اجرا:
 * 1) دریافت اطلاعات کاربر از سشن.
 * 2) استخراج نام کاربری (samadUsername) از سشن.
 * 3) ارسال درخواست به employeeService برای دریافت لیست کارمندان
 *    که parent آن‌ها برابر با نام کاربری کاربر جاری است.
 *
 * @async
 * @param {Object} session - شیء سشن کاربر (مانند req.session).
 *
 * @returns {Promise<Array<Object>>}
 * لیستی از اطلاعات کارمندان زیرمجموعه.
 *
 * @throws {Error}
 * در صورت بروز خطا در دریافت اطلاعات سشن یا سرویس employee.
 */
  async getEmployees(session) {
    const sessionInfo = await this.sessionManager.getSession(session)
      .then(res => {
        return res;
      })
      .catch(err => {
        return err;
      });
    const employeesInfo = await this.employeeService.getEmployeesInfo(sessionInfo.samadUsername);
    return employeesInfo;
  }

  /**
   * افزودن کارمند جدید توسط کاربر لاگین‌شده.
   *
   * این متد عملیات افزودن کارمند را به لایه operations واگذار می‌کند.
   * پس از اجرای موفق عملیات، پیام موفقیت‌آمیز بودن را بازمی‌گرداند.
   *
   * @async
   * @param {Object} session - شیء سشن کاربر جاری.
   * @param {Object} body - اطلاعات کارمند جدید.
   * @param {string} body.username - نام کاربری کارمند جدید.
   * @param {Object} body.data - اطلاعات شغلی کارمند جدید.
   *
   * @returns {Promise<{message: string}>}
   * در صورت موفقیت:
   * { message: "employee added successfuly." }
   *
   * @throws {Error}
   * در صورت بروز خطا در عملیات افزودن کارمند.
   */
  async addEmployee(session, body) {
    await this.operations.addEmployee(body, session, this.employeeService, this.sessionManager);
    return { message: 'employee added successfuly.' };
  }
};


exports.introduceToLoader = BaseController.exportedProperties(
  require('./schema'),
  require('./config')
);
