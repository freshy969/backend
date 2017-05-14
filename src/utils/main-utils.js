'use strict'
const _ = require('underscore')
const Trend = require('../models/trend')
var news = require('../news/news')
var tweetSearch = require('../twitter/tweet-search')
const config = require('../config')
const sentimentUtils = require('./sentiment-utils')

/**
 * Contains utilities used in the main module
 */
const mainUtils = {
  /**
   * Removes all trends from the database not located in the currTrends array.
   *
   * @param  {Array} currTrends Array of trend names (as strings) that are still trending, trends not in this array will be removed from the db
   */
  removeOldTrends: function (currTrends) {
    return new Promise((resolve, reject) => {
      Trend.remove({name: {$nin: currTrends}})
      .then(resolve)
      .catch(error => { reject(error) })
    })
  },

  /**
   * Update the trends in the database. Should be passed an array of trends
   * that are currently trending, and a TweetStream object that has been tracking
   * all trends currently in the database for the past server interval.
   *
   * @param  {Array} trends Array of trend objects that are currently trending
   * @param  {Object} tweetStream TweetStream object that has been tracking trends currently in the db for the past server interval
   */
  update: function (trends, tweetStream) {
    return new Promise((resolve, reject) => {
      let trendNames = trends.map(trend => { return trend.name })

      let streamData = tweetStream.getData()

      // Remove all old trends
      mainUtils.removeOldTrends(trendNames)

      let trendsProcessed = 0

      // Fill in other trend info
      trends.forEach(trendData => {
        news.getNews(trendData.name, newsArticles => {
          tweetSearch.getTweetSample(trendData.name, config.maxTweetsPerTrend)
          .then(tweets => {
            mainUtils.processTrend(trendData, newsArticles, tweets, streamData[trendData.name])
            .then(() => {
              // Resolve when all trends processed
              trendsProcessed++

              if (trendsProcessed === trends.length) {
                resolve()
              }
            })
          })
        })
      })
    })
  },

  /**
   * Given a specific trend, update its document in the database with the given
   * information, or create a new document for it if it does not already exist
   * in the database. Returns a promise that is resolved after the trend has
   * been saved.
   *
   * @param  {Object} trendData Data about the trend returned from the trends module
   * @param  {Array} newsArticles Array of news articles for the trend returned from the news module
   * @param  {Array} tweets Array of popular tweets for the trend returned from the tweet-search module
   * @param  {Object} streamData Data returned from the tweetStream for this trend (can be undefined if the trend just started trending)
   * @return {Promise}
   */
  processTrend: function (trendData, newsArticles, tweets, streamData) {
    return new Promise((resolve, reject) => {
      let fullTrendData = _.extend(trendData, {
        articles: newsArticles,
        tweets: tweets,
        sentiment_score: streamData ? streamData.sentiment : 0,
        sentiment_description: streamData ? sentimentUtils.getSentimentDescription(streamData.sentiment) : 'No Data',
        tweets_analyzed: streamData ? streamData.tweets_analyzed : 0,
        keywords: streamData ? streamData.keywords : []
      })

      // Try to find the trend
      Trend.findOne({name: trendData.name})
      .then(doc => {
        // If trend exists
        if (doc) {
          mainUtils.updateExistingTrend(doc, fullTrendData).then(resolve)
        } else {
          mainUtils.createNewTrend(fullTrendData).then(resolve)
        }
      }).catch(reject)
    })
  },

  /**
   * Given the existing document for a trend in the db, and newly collected
   * data for a trend, update the trend's data in the db. Returns a promise
   *
   * @param  {Object} existingTrendData MongoDB document already existing in the database for the trend
   * @param  {Object} currentTrendData Object of the same form as existingTrendData, containing new information
   * @return {Promise} Promise resolved after trend document is updated
   */
  updateExistingTrend: function (existingTrendData, currentTrendData) {
    return new Promise((resolve, reject) => {
      let newTweetsAnalyzed = existingTrendData.tweets_analyzed + currentTrendData.tweets_analyzed

      // Calculate the new sentiment score (weighting for tweets_analyzed and avoiding dividing by zero)
      let newSentimentScore = newTweetsAnalyzed > 0
        ? (currentTrendData.sentiment_score * currentTrendData.tweets_analyzed +
        existingTrendData.sentiment_score * existingTrendData.tweets_analyzed) /
        newTweetsAnalyzed : 0

      // Create a new keyword array (removing duplicates)
      let keywordsExisting = {}
      let newKeywords = existingTrendData.keywords.concat(currentTrendData.keywords)
      .filter(keyword => {
        if (keywordsExisting[keyword.word]) {
          return false
        } else {
          keywordsExisting[keyword.word] = true
          return true
        }
      })
      newKeywords.sort((a, b) => {
        return b.occurences - a.occurences
      })
      newKeywords = newKeywords.slice(0, config.maxKeywordsPerTrend)

      Trend.findOneAndUpdate({name: existingTrendData.name},
        {
          $set: {
            sentiment_score: newSentimentScore,
            sentiment_description: sentimentUtils.getSentimentDescription(newSentimentScore),
            tweets_analyzed: newTweetsAnalyzed,
            rank: currentTrendData.rank,
            keywords: newKeywords,
            tweets: currentTrendData.tweets,
            articles: currentTrendData.articles
          }
        })
      .then(resolve)
      .catch(reject)
    })
  },

  /**
   * Create a new trend in the database. Returns a promise
   *
   * @param  {Object} trendData Data for a trend as specified in the trend model
   * @return {Promise} Promise resolved arter trend is created
   */
  createNewTrend: function (trendData) {
    return new Promise((resolve, reject) => {
      new Trend(trendData).save()
      .then(resolve)
      .catch(reject)
    })
  }
}

module.exports = mainUtils
