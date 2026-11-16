module.exports={
  global: {},
  instance: {
    rewriteRules: {
      './index.html': function (headers, data, session, callback) {
        /*
                 اینجا باید با توجه به نیازمندی پروژه، آدرس فایل ایندکس را تعیین کنید
                 کد زیر تنها یک نمونه است
                 session.get(['roles'], function (error, result) {
                 if (error) {
                 callback(u.setCatched(config.e.dbError, error));
                 }
                 else {
                 callback(null, './' + result.roles[0] + '/index.html');
                 }
                 });*/
        callback(null, './indexFolder/index.html');
      }
    }
  }
};