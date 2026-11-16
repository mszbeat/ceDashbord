/**
 * ماژول مدیریت سشن کاربر.
 *
 * این ماژول یک لایه Promise-based روی متدهای session ایجاد می‌کند
 * تا بتوان از /await =استفادهasync کرد.
 *
 * عملیات‌های پشتیبانی‌شده:
 *  - ذخیره اطلاعات در سشن (setSession)
 *  - حذف سشن (removeSession)
 *  - دریافت اطلاعات از سشن (getSession)
 */
class SessionManager {

  /**
   * ذخیره اطلاعات کاربر در سشن.
   *
   * اطلاعات ذخیره‌شده شامل:
   *  - samadUsername
   *  - roles
   *
   * این متد session.set را در قالب Promise برمی‌گرداند
   * تا بتوان با /await =استفادهasync کرد.
   *
   * @param {Object} session - شیء سشن (مانند req.session).
   * @param {Object} body - اطلاعات ورود کاربر.
   * @param {string} body.username - نام کاربری.
   * @param {Array<string>} roles - لیست نقش‌های کاربر.
   *
   * @returns {Promise<any>} نتیجه‌ی متد session.set.
   *
   * @throws {Error} در صورت بروز خطا در ذخیره سشن.
   */
  setSession = async (session, body, roles) => {
    return new Promise((resolve, reject) => {
      session.set(
        { samadUsername: body.username, roles },
        (err, res) => {
          if (err) return reject(err);
          resolve(res);
        }
      );
    });
  };

  /**
   * حذف کامل سشن کاربر و پاک کردن کوکی.
   *
   * این متد:
   * 1) session.remove را اجرا می‌کند.
   * 2) در صورت موفقیت، کوکی token را از مرورگر حذف می‌کند.
   *
   * @param {Object} session - شیء سشن کاربر.
   * @param {Object} response - شیء پاسخ HTTP (مانند res در Express).
   *
   * @returns {Promise<any>} نتیجه‌ی متد session.remove.
   *
   * @throws {Error} در صورت بروز خطا در حذف سشن.
   */
  removeSession = async (session, response) => {
    return new Promise((resolve, reject) => {
      session.remove((err, resArray) => {
        if (err) return reject(err);
        this.removeCookie(response);
        resolve(resArray);
      });
    });
  };

  /**
   * دریافت اطلاعات کاربر از سشن.
   *
   * فیلدهای دریافت‌شده:
   *  - samadUsername
   *  - roles
   *
   * این متد session.get را در قالب Promise برمی‌گرداند.
   *
   * @param {Object} session - شیء سشن کاربر.
   *
   * @returns {Promise<Object>}
   * شیء شامل:
   *  - samadUsername
   *  - roles
   *
   * @throws {Error} در صورت بروز خطا در خواندن سشن.
   */
  getSession = async (session) => {
    return new Promise((resolve, reject) => {
      session.get(['samadUsername', 'roles'], (err, res) => {
        if (err) return reject(err);
        resolve(res);
      });
    });
  };

  /**
   * حذف کوکی token از مرورگر.
   *
   * این متد کوکی را با Max-Age=0 و تاریخ انقضای گذشته تنظیم می‌کند
   * تا مرورگر آن را حذف کند.
   *
   * @private
   * @param {Object} response - شیء پاسخ HTTP.
   */
  removeCookie = async (response) => {
    response.setHeader(
      'Set-Cookie',
      'token=; Path=/; Domain=localhost; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly;'
    );
  };
}

module.exports = SessionManager;