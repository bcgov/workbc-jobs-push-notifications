import {notificationsApi, jobsApi} from './config/api-config';

const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const cron = require('node-cron');
const db = require('./config/db-config');
type JobSearch = {
  user_id: string;
  keyword: string;
  location: string;
  language: string;
  token: string;
  platform: string;
};

type JobSearchesResponse = {
  rows: JobSearch[];
};
const corsOptions = {
  origin:
    process.env.ORIGIN_URL ||
    process.env.OPENSHIFT_NODEJS_ORIGIN_URL ||
    'https://localhost:8000',
  credentials: true,
  optionsSuccessStatus: 200,
};

const searchNavigation = {
  baseScreen: 'Job',
  props: {
    screen: 'Search',
  },
} as const;

function getFulfilledPromises<T>(results: Array<PromiseSettledResult<T>>): T[] {
  return results
    .filter(
      (result): result is PromiseFulfilledResult<T> =>
        result.status === 'fulfilled',
    )
    .map(result => result.value);
}


const constructJobNavigation = (jobId: string) => ({
  baseScreen: 'Job',
  props: {
    screen: 'JobDetails',
    params: {
      itemId: jobId,
    },
  },
});

const app = express();

app.use(express.json());
app.use(express.urlencoded({extended: false}));
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(helmet());

const port = process.env.PORT || '8000';

app.listen(port, () => {
  console.log('===== STARTING SERVER =====', new Date());
  console.log(`server started at http://localhost:${port}`);
  console.log('Notifications API URL: ', process.env.NOTIFICATIONS_API_URL);
  console.log('Jobs API URL: ', process.env.JOBS_API_URL);
  console.log('PG HOST: ', process.env.PGHOST);
  console.log('PG PORT: ', process.env.PGPORT);
});

// NOTE for daily at 8 use '0 8 * * *'

cron.schedule(
  '0 8 * * *',
  async () => {
    console.log('===== START CRON JOB =====');
    const minimumPostedDate = new Date();
    minimumPostedDate.setDate(minimumPostedDate.getDate() - 1);
    minimumPostedDate.setHours(8);
    minimumPostedDate.setMinutes(0);
    minimumPostedDate.setSeconds(0);
    minimumPostedDate.setMilliseconds(0);

    try {
      console.log('Getting list of all stored job searches...');
      const jobSearches: JobSearchesResponse = await db.query(
        `
          SELECT js.user_id, js.keyword, js.location, js.language, t.token, t.platform
          FROM job_searches js
          INNER JOIN tokens t ON js.user_id = t.user_id
          WHERE js.user_removed = FALSE
          `,
        [],
      );

      const uniqueSearchesToUserIDs = new Map<string, JobSearch[]>();
      const keywordLocationMap = new Map<string, string[]>();

      for (const row of jobSearches.rows) {
        const key = `${row.keyword}#${row.location}#${row.language}`;
        if (keywordLocationMap.has(key)) {
          keywordLocationMap.get(key)?.push(row.user_id);
        } else {
          keywordLocationMap.set(key, [row.user_id]);
        }
        if (uniqueSearchesToUserIDs.has(row.user_id)) {
          uniqueSearchesToUserIDs.get(row.user_id)?.push(row);
        } else {
          userIdToSearchesMap.set(row.user_id, [row]);
        }
      }
      console.log('UserID to Searches map size:: ', userIdToSearchesMap.size);
      console.log(
        'Keyword-Location to UserID map size: ',
        keywordLocationMap.size,
      );
      const sortedKeywordLocationMap = new Map(
        [...keywordLocationMap.entries()].sort(
          (a, b) => b[1].length - a[1].length,
        ),
      );

      for await (const [key, value] of sortedKeywordLocationMap) {
        const [keyword, location, language] = key.split('#');
        console.log(
          `keyword: ${keyword}, location: ${location}, language: ${language}`,
        );
        const hasUserThatNeedsNotification = value.some(userId =>
          uniqueSearchesToUserIDs.has(userId),
        );

        if (!hasUserThatNeedsNotification) {
          continue;
        }

        try {
          const response = await jobsApi.get('Jobs/SearchJobs', {
            data: {
              jobTitle: keyword,
              location: location,
              language: language,
              minimumPostedDate: minimumPostedDate,
            },
          });
          const responseData = response.data;
          const isNewJobs =
            responseData.new > 0 && responseData.jobs.length > 0;
          if (isNewJobs) {
            for await (const userId of value) {
              if (uniqueSearchesToUserIDs.has(userId)) {
                const userJobSearches = uniqueSearchesToUserIDs.get(userId);
                const currentSearch = userJobSearches?.find(
                  search =>
                    search.keyword === keyword && search.location === location,
                );
                if (currentSearch) {
                  const firstJobId = responseData.jobs[0].JobId;

                  const data =
                    (responseData.new > 1 && responseData.jobs.length > 0) ||
                    !firstJobId
                      ? searchNavigation
                      : constructJobNavigation(firstJobId);
                  try {
                    await notificationsApi.post(
                      'messaging/send',
                      {
                        title:
                          currentSearch.language.toUpperCase() === 'EN'
                            ? 'New Jobs Posted'
                            : "Nouvelles offres d'emploi",
                        content:
                          currentSearch.language.toUpperCase() === 'EN'
                            ? 'There are new job postings for one or more of your saved job searches!'
                            : 'Il y a de nouvelles offres d’emploi pour une ou plusieurs de vos recherches d’emploi sauvegardées!',
                        token: currentSearch.token,
                        platform: currentSearch.platform,
                        dryRun: false,
                        data,
                      },
                      {
                        auth: {
                          username: process.env.NOTIFICATIONS_API_USER || '',
                          password: process.env.NOTIFICATIONS_API_PASS || '',
                        },
                      },
                    );
                    uniqueSearchesToUserIDs.delete(userId);
                    console.log(
                      'UserID to Searches map size: ',
                      uniqueSearchesToUserIDs.size,
                    );
                  } catch (e: any) {
                    console.log(
                      'Error sending notification. Message: ',
                      e.message,
                    );
                  }
                }
              }
            }
          }
        } catch (e: any) {
          console.log('Error searching jobs. Message: ', e.message);
        }
      }
      console.log('===== END CRON JOB =====');
    } catch (e: any) {
      console.log(e.message);
    }
  },
  {
    scheduled: true,
    timezone: 'America/Los_Angeles',
  },
);
