exports.addEmployee = {
  body: {
    type: 'object',
    properties: {
      username: {
        username: [],
        errorMessages: {
          username: 'username not valid'
        }
      },
      data: {
        type: 'object',
        properties: {
          nationalCode: {
            nationalCode: [],
            type: 'string',
            errorMessages: {
              type: 'nationalCode not valid',
              nationalCode: 'nationalCode not valid'
            }
          },
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
        },
        required: ['nationalCode', 'jobSkillse', 'jobTitle'],
        additionalProperties: false
      },

    },
    required: ['data', 'username'],
    additionalProperties: false
  }
};