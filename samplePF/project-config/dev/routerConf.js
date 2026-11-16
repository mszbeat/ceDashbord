const path=require('path');
module.exports={
  routerPath: path.join(`${__dirname}`, '../../routes.js'),
  accessControl : {
    partSessionManagerConfig : require('./dependencies/partSessionManagerConfig'),
    partSecurityConfig : require('./dependencies/partSecurityConfig'),
    config: {
      org: 'mohammadsadeghZarei'
    }
  }
};