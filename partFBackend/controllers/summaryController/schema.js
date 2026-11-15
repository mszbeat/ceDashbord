exports.health = function () {
  return {
    header: {},
    params: {},
    queryString: {},
  };
};

exports.banks = function () {
  return {
    header: {},
    params: {},
    queryString: {},
  };
};

exports.specs = function () {
  return {
    header: {},
    params: {},
    queryString: {
      bank: {},
    },
  };
};

exports.report = function () {
  return {
    header: {},
    params: {},
    queryString: {
      bank: {},
      from: {},
      to: {},
      rowsCap: {},
    },
  };
};

exports.diagnostics = function () {
  return {
    header: {},
    params: {},
    queryString: {},
  };
};

exports.summary = function () {
  return {
    header: {},
    params: {},
    queryString: {
      bank: {},
      from: {},
      to: {},
    },
  };
};

exports.list = function () {
  return {
    header: {},
    params: {},
    queryString: {
      bank: {},
      from: {},
      to: {},
      indicator: {},
      type: {},
      id: {},
      value: {},
      status: {},
      limit: {},
      offset: {},
    },
  };
};

exports.sample = function () {
  return {
    header: {},
    params: {
      requestId: {},
    },
    queryString: {},
  };
};

exports.runs = function () {
  return {
    header: {},
    params: {},
    queryString: {},
  };
};
