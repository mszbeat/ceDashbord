const properties = {
  jobSkillse: {
    type: 'string',
    errorMessages: {
      type: 'jobSkillse not valid'
    }
  },
  jobTitle: {
    type: 'string',
    errorMessages: {
      type: 'jobTitle not valid'
    }
  },
  firstName: {
    alpha: [' '],
    errorMessages: {
      alpha: 'firstName not valid'
    }
  },
  lastName: {
    alpha: [' '],
    errorMessages: {
      alpha: 'lastName not valid'
    }
  },
  education: {
    type: 'string',
    minLength: 1,
    errorMessages: {
      type: 'education type most be \'string\'',
      minLength: 'education minimum length most be 1'
    }
  },
  gender: {
    type: 'string',
    enum: ['0', '1'],
    errorMessages: {
      type: 'gender not valid',
      enum: 'gender most equal 0(male) or 1(female) valid',
    }
  },
  email: {
    email: [],
    errorMessages: {
      email: 'name not valid'
    }
  },
  parent: {
    username: [],
    errorMessages: {
      username: 'parent not valid'
    }
  }
};

exports.signUp = {
  body: {
    type: 'object',
    properties: {
      ...properties,
      password: {
        password: [],
        errorMessages: {
          password: 'password not valid'
        }
      },
      nationalCode: {
        nationalCode: [],
        type: 'string',
        errorMessages: {
          type: 'nationalCode not valid',
          nationalCode: 'nationalCode not valid'
        }
      },
      username: {
        username: [],
        errorMessages: {
          username: 'username not valid'
        }
      }
    },
    required: ['password', 'username', 'nationalCode', 'email', 'firstName', 'lastName', 'jobSkillse', 'jobTitle', 'gender', 'education', 'parent'],
    additionalProperties: false

  }
};
exports.updateInfo = {
  body: {
    type: 'object',
    properties: {
      ...properties
    },
    additionalProperties: false

  }
};

exports.login = {
  body: {
    type: 'object',
    properties: {
      username: {
        username: [],
        errorMessages: {
          username: 'username not valid'
        }
      },
      password: {
        password: [],
        errorMessages: {
          password: 'password not valid'
        }
      },
    },
    required: ['username', 'password']
  }
};