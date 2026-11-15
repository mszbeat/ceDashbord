const BaseController = require('@partFramework/baseController');
const helpers = require('./helpers');

class IngestionController extends BaseController {
  @Route('/api/runs')
  @HTTP('POST')
  run(protocolRef) {
    return helpers.run(protocolRef);
  }
}

module.exports = {
  controller: IngestionController,
  introduceToLoader: BaseController.exportedProperties(
    require('./schema'),
    require('./config')
  )
};
