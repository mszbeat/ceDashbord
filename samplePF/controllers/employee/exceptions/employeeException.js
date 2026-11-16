module.exports = (exception) => {  
  return {
    statusCode: exception?.statusCode||500,
    data: exception?.data||exception?.error||exception,
    meta: exception?.meta
  };
};