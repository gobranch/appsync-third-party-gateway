const {
  AuthenticationError,
  UserInputError,
  SyntaxError,
} = require("apollo-server-lambda");
const log = require("lambda-log");

// We're including this to demonstrate how to send errors in the
// gateway to an error tracking service. Use a real one in your
// own code obviously.
const FictionalErrorTrackingService = {
  captureException(exception) {
    log.error(exception);
  },

  setExtraInfo(extraInfoFieldName, extraInfoFieldValue) {
    // Equivalent to Sentry.setExtra for example
    log.info(
      "Setting extraInfo in FictionalErrorTrackingService",
      extraInfoFieldName,
      extraInfoFieldValue
    );
  },

  async flush() {
    log.info("flushing errors to FictionalErrorTrackingService with timeout");
  },
};

const errorTracker = {
  async requestDidStart(ctx) {
    FictionalErrorTrackingService.setExtraInfo("query", ctx.request.query);
    FictionalErrorTrackingService.setExtraInfo(
      "variables",
      ctx.request.variables
    );

    if (ctx.context.contextError) {
      log.error(ctx.context.contextError);

      // Let's not make life even harder than it already is for people who have error
      // tracker alerts on by notifying them every time someone forgets to include their
      // API key
      if (ctx.context.contextError instanceof AuthenticationError) {
        throw ctx.context.contextError;
      }

      FictionalErrorTrackingService.captureException(ctx.context.contextError);
      await FictionalErrorTrackingService.flush();
      throw new Error("Internal Server Error");
    }

    if (ctx.context.affinity) {
      FictionalErrorTrackingService.setExtraInfo(
        "affinity",
        ctx.context.affinity
      );
    }

    // We need to set these using the parsingDidStart, validationDidStart and
    // didResolveOperation hooks instead of checking for them
    // in didEncounterErrors because we can't identify these
    // exactly in didEncounterErrors.
    //
    // https://github.com/apollographql/apollo-server/issues/5936
    // https://community.apollographql.com/t/cant-always-get-extensions-property-of-error-in-didencountererrors/847
    let graphqlParsingFailure = false;
    let graphqlValidationFailure = false;
    let graphqlUnknownOperationName = false;

    return {
      async parsingDidStart() {
        return async (parsingError) => {
          if (parsingError) {
            graphqlParsingFailure = true;
          }
        };
      },

      async validationDidStart() {
        return async (validationErrors) => {
          if (validationErrors && validationErrors.length !== 0) {
            graphqlValidationFailure = true;
          }
        };
      },

      async didResolveOperation(requestContext) {
        if (requestContext.operationName === undefined) {
          graphqlUnknownOperationName = true;
        }
      },

      async didEncounterErrors(requestContext) {
        log.info("didEncounterErrors", requestContext.errors);

        // We don't want to report these to Sentry because they're a result
        // of badly formatted requests by callers and they get notified
        // of the error in the response.
        if (
          graphqlParsingFailure ||
          graphqlValidationFailure ||
          graphqlUnknownOperationName
        ) {
          return;
        }

        for (const err of requestContext.errors) {
          log.error(err);

          // If the error is coming from AppSync then we don't need to
          // send it to our error tracking service again here.
          if (err.extensions?.code === "APPSYNC_PASSTHROUGH_ERROR") {
            continue;
          }

          // We also don't want to send errors that come from
          // bad user input to our error tracking service.
          if (err instanceof UserInputError || err instanceof SyntaxError) {
            continue;
          }

          console.log("SENDING TO SENTRY");
          FictionalErrorTrackingService.captureException(err);
        }

        await FictionalErrorTrackingService.flush();
      },
    };
  },
};

const requestResponseLogger = {
  async requestDidStart(requestContext) {
    log.info("GraphQL request", {
      query: requestContext.request.query,
      variables: requestContext.request.variables,
      context: requestContext.context,
    });

    return {
      async willSendResponse(requestContext) {
        log.info("GraphQL response", { response: requestContext.response });
      },
    };
  },
};

module.exports = { errorTracker, requestResponseLogger };
