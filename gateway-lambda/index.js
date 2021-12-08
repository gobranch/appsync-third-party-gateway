const process = require("process");
const fetch = require("cross-fetch");
const AWS = require("aws-sdk");
const { print, GraphQLError } = require("graphql");
const fs = require("fs");
const { wrapSchema, introspectSchema } = require("@graphql-tools/wrap");
const { delegateToSchema } = require("@graphql-tools/delegate");
const {
  gql,
  ApolloServer,
  AuthenticationError,
} = require("apollo-server-lambda");
const { ApolloServerPluginLandingPageDisabled } = require("apollo-server-core");
const { requestResponseLogger, errorTracker } = require("./plugins");

const APPSYNC_URL = process.env.APPSYNC_URL;
const APPSYNC_API_KEY = process.env.APPSYNC_API_KEY;
const API_USERS_TABLE_NAME = process.env.API_USERS_TABLE_NAME;

const ddbDocClient = new AWS.DynamoDB.DocumentClient();

async function getAffinityFromApiKey(apiKey) {
  const apiKeyRecord = await ddbDocClient
    .get({
      TableName: API_USERS_TABLE_NAME,
      Key: {
        apiKey,
      },
    })
    .promise();

  return apiKeyRecord.Item?.affinity || null;
}

async function createApolloServer() {
  const appSyncRemoteExecutor = async ({ document, variables }) => {
    const fetchResult = await fetch(APPSYNC_URL, {
      method: "POST",
      headers: { "x-api-key": APPSYNC_API_KEY },
      body: JSON.stringify({ query: print(document), variables }),
    });
    return fetchResult.json();
  };

  const appSyncRemoteSchema = wrapSchema({
    schema: await introspectSchema(appSyncRemoteExecutor),
    executor: appSyncRemoteExecutor,
  });

  // Transforms errors that come from AppSync to have the extensions.code
  // property set to 'APPSYNC_PASSTHROUGH_ERROR' so that the formatErrors
  // handler can differentiate between errors coming from AppSync (which we
  // want to pass through as-is) and errors coming from this Lambda (which we
  // we want to mask as internal server errors)
  const appSyncPassThroughErrorTransform = {
    transformResult: (originalResult) => {
      if (originalResult.errors) {
        originalResult.errors = originalResult.errors.map((error) => {
          return new GraphQLError(
            error.message,
            error.nodes,
            error.source,
            error.positions,
            error.path,
            error.originalError,
            { ...error.extensions, code: "APPSYNC_PASSTHROUGH_ERROR" }
          );
        });
      }
      return originalResult;
    },
  };

  const gatewaySchema = fs
    .readFileSync(`${__dirname}/schema.graphql`)
    .toString();
  const gatewayTypeDefs = gql(gatewaySchema);

  // You need to define resolvers for the fields in your gateway schema here
  // and can also make whatever modifications you want before passing the
  // request through to AppSync. In our case we're adding the affinity code
  // of the developer making the request as an extra argument to the query.
  const gatewayResolvers = {
    Query: {
      async sayHello(parent, args, context, info) {
        return delegateToSchema({
          schema: appSyncRemoteSchema,
          operation: "query",
          fieldName: "sayHello",
          args: { ...args, affinity: context.affinity },
          context,
          info,
          transforms: [appSyncPassThroughErrorTransform],
        });
      },
    },
    Mutation: {
      async someRandomMutation(parent, args, context, info) {
        return delegateToSchema({
          schema: appSyncRemoteSchema,
          operation: "mutation",
          fieldName: "someRandomMutation",
          args: { ...args, affinity: context.affinity },
          context,
          info,
          transforms: [appSyncPassThroughErrorTransform],
        });
      },
    },
  };

  return new ApolloServer({
    typeDefs: gatewayTypeDefs,
    resolvers: gatewayResolvers,
    context: async ({ express }) => {
      // Developers using this API must include their API key in the authorization header of their
      // request. We'll use this identify them and pull their affinity code (unique identifier for the developer)
      // and attach it to the Apollo context for this request.
      //
      // https://www.apollographql.com/docs/apollo-server/data/resolvers/#the-context-argument
      // https://www.apollographql.com/docs/apollo-server/security/authentication/#putting-authenticated-user-info-on-the-context
      try {
        const apiKey = express.req.headers.authorization;
        if (!apiKey) {
          throw new AuthenticationError("Missing authorization header");
        }

        const affinity = await getAffinityFromApiKey(apiKey.trim());
        if (!affinity) {
          throw new AuthenticationError("Invalid authorization header");
        }

        return { affinity };
      } catch (err) {
        // Throwing in the context function adds a "Context creation failed:"
        // prefix to the error, and also skips over the errorHandler plugin.
        // We don't want either of those so we'll add the error
        // to the context field instead and handle it in the errorHandler
        // plugin.
        //
        // https://github.com/apollographql/apollo-server/issues/3223
        // https://github.com/apollographql/apollo-server/issues/3025
        return { contextError: err };
      }
    },
    formatError: (err) => {
      // This function runs just before errors are returned to the caller.
      // We're logging / sending the original errors to our error tracker in the
      // errorTracker plugin before this runs so we'll just mask / remove
      // anything that shows our code structure here so it isn't exposed
      // to the caller.
      //
      // https://www.apollographql.com/docs/apollo-server/data/errors/#for-client-responses
      delete err.stack;
      delete err.extensions?.exception;

      // If an error is coming from AppSync we want to pass it through as-is.
      // We'll get rid of the code though because the only reason we have it is
      // to check here.
      if (err.extensions?.code === "APPSYNC_PASSTHROUGH_ERROR") {
        delete err.extensions;
      }

      // If an error isn't coming from AppSync it means it's coming from this Lambda.
      //
      // Any error thrown that isn't one of Apollo's special subclassed errors will have this code.
      // We'll rewrite the message on these errors to mask what happened and just say internal
      // server error.
      //
      // https://www.apollographql.com/docs/apollo-server/data/errors/#error-codes
      if (err.extensions?.code === "INTERNAL_SERVER_ERROR") {
        err.message = "Internal Server Error";
        delete err.extensions;
      }

      return err;
    },
    plugins: [
      requestResponseLogger,
      errorTracker,
      ApolloServerPluginLandingPageDisabled(),
    ],
  });
}

let apolloHandler;

const handler = async (event, context, callback) => {
  if (!apolloHandler) {
    const apolloServer = await createApolloServer();
    apolloHandler = apolloServer.createHandler();
  }

  return apolloHandler(event, context, callback);
};

exports.handler = handler;
