# AppSync Third Party Gateway

An example of how to construct a fully-serverless GraphQL API gateway to expose controlled and authenticated access to an AppSync API for third party developers. You're free to use it as a reference to construct your own third party developer gateways for AppSync. You're also free to use the code itself partially or in it's entirety as you see fit.

This code is currently used by [Branch Insurance](https://ourbranch.com) with only slight modifications for internal error tracking libraries, tracing etc.

## Features

- Allow accessing either the entire or a subset of an AppSync API at the field level.
- Create API keys for individual developers.
- Attach unique identifier keys (in insurance we call these affinities / affinity codes which is the terminology used in this example code) based on the developer making the request before forwarding them to AppSync so you can identify who the request is coming from in your AppSync resolvers